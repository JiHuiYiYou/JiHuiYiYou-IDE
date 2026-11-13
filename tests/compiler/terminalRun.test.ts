import { describe, expect, it } from 'vitest'
import { TerminalSession } from '../../src/main/terminal'
import {
  BASH_INTEGRATION_SCRIPT,
  POWERSHELL_INTEGRATION_SCRIPT,
} from '../../src/main/shellIntegration'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * **「运行」的程序跑在 shell 的那个 pty 里** —— VS Code 的任务终端模型。
 *
 * ## 为什么这么重要
 *
 * 程序以前跑在**自己的** pty 里，输出再**注入**到终端的显示层。
 * ⇒ 注入的内容**不在 conhost 的屏幕里** ⇒
 *    ConPTY 一 resize（拖面板分割线、全屏↔下栏）就会**整屏重画**
 *    （实测：conhost 发的是 `ESC[H` + 提示符 + 每行 `ESC[K\r\n`）
 *    ⇒ 注入的那段**必被抹掉**，而提示符是 conhost 自己画的 ⇒ 倒是不丢 ✗
 *    ⇒ 用户报过：「调整下栏大小会把程序的输出卡没」「全屏到下栏也会」
 *
 * ⇒ 现在程序是 **shell 的孩子** ⇒ 它的输出**就在** conhost 的屏幕里
 *    ⇒ resize 重画是忠实的 ⇒ 输出不会没 ✓
 *
 * ## 这些测试钉住的是「新架构」的三件事
 *
 * 1. 命令**真的**进了 shell 的 stdin（⇒ 程序是 shell 的孩子 ⇒ 输出同屏）✓
 * 2. 退出码是**准的**（不是 VS Code 那套只有 0/1 的「假码」）✓
 * 3. **认得出哪条命令跑完了**（用户自己敲的命令不能被当成我们的）✓
 */

/** 起一个真的 bash（管道后端 —— 测试不该取决于「装没装 node-pty」）。 */
async function makeBash(): Promise<{
  session: TerminalSession
  /** 临时目录（脚本文件放这儿） */
  dir: string
  /** 终端里流过的**全部文本**（数提示符用） */
  output: () => string
  /** 把 HOME 环境变量改回去 */
  restore: () => void
}> {
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-run-'))
  // ⚠️ **别加载用户自己的 ~/.bashrc** —— 它可能很慢（nvm/conda init…）
  //    ⇒ 机器一忙，命令就迟迟跑不起来 ⇒ 测试会偶发失败 ⇒ HOME 指到空目录 ✓
  const oldHome = process.env.HOME
  const oldProfile = process.env.USERPROFILE
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  let text = ''
  const session = new TerminalSession({
    shell: 'bash',
    cwd: dir,
    onData: (e) => {
      text += e.data
    },
    onExit: () => {},
    backend: 'pipe',
  })
  // 等 shell 真的空闲了（提示符出来了）再发命令
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000 && session.shellState.idle !== true) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return {
    session,
    dir,
    output: () => text,
    restore: () => {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = oldProfile
    },
  }
}

/**
 * 数一数终端里出现了几次 **bash 的提示符**。
 *
 * ⚠️ 提示符是 **shell 自己**画的 ⇒ 数它就知道「有几轮提示符」✓
 *    ⇒ 以前 IDE「补提示符」那个机制会**多出一轮** ✗
 * ⚠️ **认不出提示符就返回 0** ⇒ 调用方据此**跳过**那条断言
 *    （不同机器的 PS1 不一样 ⇒ 硬认会误伤 CI）✓
 */
function countPrompts(text: string): number {
  // ⚠️ bash 的默认 PS1 里带一个「设置窗口标题」的 OSC ⇒ 每个提示符一个 ✓
  const byTitle = (text.match(/\x1b\]0;/g) ?? []).length
  if (byTitle > 0) return byTitle
  // 兜底：默认 PS1 是 `bash-x.y$ `
  return (text.match(/bash-[0-9.]+[$#]\s?/g) ?? []).length
}

describe('让 shell 跑命令（新的「运行」架构）', () => {
  it('命令进了 shell ⇒ 拿得到**真实的**退出码', async () => {
    const { session, dir, restore } = await makeBash()
    try {
      // ⚠️ **必须是「简单命令」** ——
      //    bash 的 DEBUG trap（它报「这条命令是什么」）**对子 shell 不触发**
      //    （实测：`(exit 42)` 不触发，`echo done` 触发）⇒
      //    IDE 自己发的运行命令是 `& 'C:\path\prog.exe'` 这种**简单命令** ✓
      //    这里用一个脚本文件（相对路径 ⇒ 不依赖 PATH）✓
      const script = join(dir, 'exit42.sh')
      writeFileSync(script, '#!/bin/sh\nexit 42\n', 'utf8')
      const run = await session.runCommand('./exit42.sh', { match: 'exit42.sh' })
      expect(run.exitCode).toBe(42)
      expect(run.timedOut).toBe(false)
    } finally {
      await session.kill()
      restore()
    }
  })

  it('跑的时候流过的文本会被攒下来（给「程序输出」用）', async () => {
    const { session, restore } = await makeBash()
    try {
      const run = await session.runCommand('echo hello-from-program', { match: 'echo' })
      expect(run.output).toContain('hello-from-program')
    } finally {
      await session.kill()
      restore()
    }
  })

  it('**认得出哪条命令跑完了** —— 命令名对不上就不认（⇒ 用户的命令不会被当成我们的）', async () => {
    const { session, dir, restore } = await makeBash()
    try {
      const script = join(dir, 'exit42.sh')
      writeFileSync(script, '#!/bin/sh\nexit 42\n', 'utf8')
      // ⚠️ 命令跑完了，但它的命令行里**没有**我们等的那个片段
      //    ⇒ 不该认 ⇒ 一直等到超时 ✓
      const run = await session.runCommand('./exit42.sh', {
        match: '完全对不上的名字',
        timeoutMs: 800,
      })
      expect(run.timedOut).toBe(true)
      expect(run.exitCode).toBe(null)
    } finally {
      await session.kill()
      restore()
    }
  })
})

describe('提示符只出现一次（VS Code 的模型）', () => {
  it('**没有「让 shell 重打提示符」这个机制了**（它会多一个提示符）', async () => {
    const { session, restore } = await makeBash()
    try {
      const s = session as unknown as Record<string, unknown>
      // ⚠️ 这两个方法以前在 `TerminalSession` 上 ——
      //    加回来就意味着「多一个提示符」+「退出码被改成 0」✗
      expect(s.prompt).toBeUndefined()
      expect(s.forcePrompt).toBeUndefined()
    } finally {
      await session.kill()
      restore()
    }
  })

  it('**跑完命令之后，终端里没有多出来的提示符**', async () => {
    const { session, output, restore } = await makeBash()
    try {
      const before = countPrompts(output())
      await session.runCommand('echo hello-once', { match: 'echo' })
      // ⚠️ **等提示符真的出来** —— 别用固定等待（并行跑的时候 500ms 不够 ⇒ 会偶发红）✓
      const t0 = Date.now()
      while (Date.now() - t0 < 10_000 && countPrompts(output()) <= before) {
        await new Promise((r) => setTimeout(r, 100))
      }
      const after = countPrompts(output())
      // ⚠️ **只多了 1 个** —— 命令跑完 shell 自己打的那个 ✓
      //    （以前 IDE 还会「补」一个 ⇒ 多了 2 个 ✗）
      //    ⇒ 认不出提示符的机器上**跳过** ✓
      if (before > 0) {
        expect(after - before).toBeLessThanOrEqual(1)
        expect(after - before).toBeGreaterThanOrEqual(1)
      }
    } finally {
      await session.kill()
      restore()
    }
  })
})

describe('shell 集成（OSC 633）', () => {
  it('**提示符出来了 ⇒ 集成真的起来了**（idle 变 true）', async () => {
    const { session, restore } = await makeBash()
    try {
      // makeBash 已经等到提示符了 ⇒ 集成肯定起来了 ✓
      expect(session.shellState.idle).toBe(true)
      // ⚠️ **当前目录也报上来了** ⇒ 说明 OSC 633 的 `P;Cwd=` 也收到了 ✓
      expect(session.shellState.cwd).toBeTruthy()
    } finally {
      await session.kill()
      restore()
    }
  })

  it('**cmd 没有集成 ⇒ 永远不会有 OSC**（但那也不影响「运行」了）', async () => {
    // ⚠️ 现在「运行」**不靠 OSC 633 判完成**了（靠终端进程退出）
    //    ⇒ 集成挂了也照样能跑 ✓ ⇒ 这个只是记录一下现状
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-nointegr-'))
    const session = new TerminalSession({
      shell: 'cmd',
      cwd: dir,
      onData: () => {},
      onExit: () => {},
      backend: 'pipe',
    })
    try {
      expect(session.shellState.idle).toBeNull()
    } finally {
      await session.kill()
    }
  })
})


describe('冷终端（刚建的）⇒ 「运行」也要走好路', () => {
  it('**冷终端（刚建的）⇒ 等到集成之后，程序照样跑在 shell 的 pty 里**', async () => {
    /*
      ⚠️⚠️ **这就是用户报的那个场景** ——
        「一个终端都没有 ⇒ 点运行 ⇒ 主进程新建一个 ⇒ **冷 shell**」
        ⇒ 以前「编译完再等 2 秒」⇒ 经常等不到 ⇒ **静悄悄退回老路**
        ⇒ 老路的输出是「注入」的 ⇒ **ConPTY 一重画就被抹掉**
        ⇒ 用户看到「终端刷新（清空）了程序打印，然后只剩提示符」✗

        ⇒ 现在：**等待提前挂上**（跟编译重叠）+ **预算 15 秒** ⇒
          等得到 ⇒ **走好路**（程序是 shell 的孩子 ⇒ 输出真在 conhost 屏幕里
          ⇒ 不会被重画抹掉）✓
    */
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-cold-'))
    // ⚠️ **别加载用户自己的 ~/.bashrc** —— 它可能很慢 ⇒ 测试会偶发失败 ✓
    const oldHome = process.env.HOME
    const oldProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    const session = new TerminalSession({
      shell: 'bash',
      cwd: dir,
      onData: () => {},
      onExit: () => {},
      backend: 'pipe',
    })
    try {
      // ⚠️ **不等它空闲** —— 模拟「刚建出来的冷终端」
      // ⚠️⚠️ **现在「运行」压根不等 shell 集成** ——
      //   命令是 **shell 的启动参数**（VS Code 的 task 终端）⇒
      //   判完成靠**终端进程退出** ⇒ 集成挂了也照样能跑 ✓
      const script = join(dir, 'exit7.sh')
      writeFileSync(script, '#!/bin/sh\nexit 7\n', 'utf8')
      const run = await session.runProgram(script, { cwd: dir })
      expect(run.exitCode).toBe(7)
      expect(run.terminalClosed).toBeFalsy()
    } finally {
      await session.kill()
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
      if (oldProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = oldProfile
    }
  })
  it('终端死了 ⇒ 运行**立刻收场**（不能永远卡在「运行中…」）', async () => {
    const { session, restore } = await makeBash()
    try {
      // 一条跑很久的命令（不会自己结束）
      // ⚠️ **`sleep` 来自 coreutils** —— CI 上如果 MSYS2 装得瘦（只装
      //    `base-devel`）⇒ bash 会**立刻**「command not found」⇒ 命令瞬间完成
      //    ⇒ 「命令完成」那条路径先收场 ⇒ `terminalClosed` 是 undefined
      //    ⇒ **这条断言就赢了「命令完成」而不是「终端死了」** ⇒ 门红
      //    （2026-11-12 实测：本地过、CI 红 ⇒ CI 的 CI 文件已显式装 coreutils）。
      const pending = session.runCommand('sleep 30', { match: 'sleep' })
      // 等命令真的发出去了
      await new Promise((r) => setTimeout(r, 300))
      // ⚠️ **终端死了** —— 「命令跑完」那个 OSC 633 永远不会来了
      await session.kill()
      const run = await pending
      // ⚠️ **失败信息带上现场** —— 光一句 "expected undefined to be true" 看不出
      //    是「终端没死」还是「命令提前结束」⇒ 白排查一轮。
      expect(
        run.terminalClosed,
        `终端死了但没报 terminalClosed（exitCode=${run.exitCode} timedOut=${run.timedOut}）` +
          ` —— 多半是**命令提前结束了**（CI 上 \`sleep\` 不存在？）`,
      ).toBe(true)
      expect(run.exitCode).toBe(null)
    } finally {
      restore()
    }
  })
})

describe('shell 集成脚本', () => {
  it('两个 shell 都要报「这条命令**是什么**」（IDE 靠它认出哪条命令跑完了）', () => {
    // ⚠️ **必须有这一条** —— 没有它，IDE 分不清
    //    「我的程序跑完了」和「用户自己敲的命令跑完了」⇒ 退出码张冠李戴 ✗
    expect(BASH_INTEGRATION_SCRIPT).toContain('__jhyy_seq "E;$1"')
    expect(POWERSHELL_INTEGRATION_SCRIPT).toContain('633;E;')
  })

  it('PowerShell 的退出码要取 $LASTEXITCODE（原生程序的**真实**退出码）', () => {
    // ⚠️ VS Code 那套是「$? 的反面」⇒ 只有 0/1 ⇒
    //    分不出「Ctrl+C 中断（0xC000013A）」和「真崩了」⇒
    //    用户报过「程序崩溃：NTSTATUS0xC000013A 是什么鬼」✗
    expect(POWERSHELL_INTEGRATION_SCRIPT).toContain('$global:LASTEXITCODE')
  })
})
