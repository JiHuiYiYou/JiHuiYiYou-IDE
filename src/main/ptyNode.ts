import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { TerminalShell } from '@shared/terminal'
import { buildSubprocessEnv } from './compiler/env'
import { OutputBatcher, type PtySession, type PtySpawnOptions } from './pty'
import { shellCommandArgs, withShellIntegration } from './shellIntegration'
import { loadLoginShellEnvSync, mergeShellEnv } from './shellEnv'

/**
 * **真控制台版**的终端后端 —— `node-pty`（Windows 上就是 ConPTY）。
 *
 * ## 为什么是「真控制台」
 *
 * 程序拿到的是**控制台设备**（`CONOUT$`）⇒
 * - `isatty(1)` 是 TRUE ⇒ **C 运行时不再全缓冲 stdout** ⇒
 *   `printf("请输入一个数字: ")` 立刻显示 ✓
 * - `vim` / `top` 这类全屏 TUI **能跑** ✓（管道版它们直接拒绝运行）
 * - 窗口尺寸对得上（`resize()` ⇒ 内核发 SIGWINCH ⇒ 程序重排 ✓）
 * - ANSI/颜色是终端自己处理的，不用来回转义
 *
 * ## 为什么要动态 require
 *
 * `node-pty` 是**原生模块**（要按 Electron 的 ABI 重新编译 ⇒ 要 MSVC
 * Build Tools）。**没装 MSVC 的机器编不出来** ⇒ 不能让 `npm install` 直接失败。
 *
 * ⇒ 所以它必须是**可选依赖**（`optionalDependencies`）：装了就用，没装就
 * 退回管道版（`ptyFactory.ts` 负责挑）⇒ 打包/CI 上没 MSVC 也能构建 ✓。
 *
 * ⚠️ 重编这一步在 `scripts/prepare-node-pty.mjs`（`postinstall` 跑）——
 *    它还得给 winpty 的 gyp 打三个补丁，见那个脚本的注释。
 */

/**
 * **预热** node-pty —— 启动时把原生模块**加载并缓存**起来。
 *
 * ## 为什么必须预热（不然终端会「一会真一会假」）
 *
 * node-pty 的原生模块（`build/Release/conpty.node`）是**懒加载**的 ——
 * `require('node-pty')` 根本不碰它，**第一次 spawn 时**才 `require`。
 *
 * ⚠️ 而 **`npm install` 会把那个文件删掉**！
 *    node-pty 自己的 `postinstall` 脚本有个 bug：它拿**绝对路径**去比
 *    BUILD_FILES（里面是**相对文件名**）⇒ 比不中 ⇒
 *    **把 `build/Release` 整个清空** ⇒（我们的 postinstall 随后会重编回来，
 *    但**中间有个窗口**）
 *
 * ⇒ 那个窗口里，**正在跑的 IDE** 起新的终端就会失败 ⇒
 *    静悄悄退回管道版 ⇒ **「终端一会真一会假」**（用户报过）✓
 *
 * ⇒ 启动时先起一个「马上就退出」的真控制台：
 *    ① 原生模块被**加载进 Node 的模块缓存** ⇒ 之后文件被删也不影响 ✓
 *       （`Module._cache` 按**解析后的绝对路径**做键 ⇒ node-pty 后面再
 *        require 同一个文件就是**缓存命中**，不再去碰磁盘 ✓）
 *    ② 顺便验一下「这台机器到底能不能起真控制台」✓
 */
export function warmUpNodePty(): { ok: boolean; error?: string } {
  const nodePty = tryLoadNodePty()
  if (!nodePty) {
    return { ok: false, error: 'node-pty 模块没装（可选依赖没装上？）' }
  }
  try {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    const p = nodePty.spawn('cmd.exe', ['/c', 'exit'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env,
      useConpty: true,
    })
    // 它马上就自己退了；kill 只是兜底（别留个孤儿进程）
    try {
      p.kill()
    } catch {
      // 已经退了
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 终端该拿到的**环境变量**。
 *
 * ⚠️ **登录 shell 那份** —— 用户的 nvm/rbenv/conda init 都在那儿 ⇒
 *    用户在自己终端里能用的工具，IDE 的终端里也得能用 ✓
 *
 * ⚠️ 主进程和「pty 宿主进程」都用这个 —— 宿主进程不用自己再起一个登录 shell
 *    去导（那个活儿归主进程，它还缓存着）✓
 */
export function buildTerminalEnv(shell: TerminalShell): Record<string, string> {
  const loginEnv = loadLoginShellEnvSync(shell)
  return buildSubprocessEnv(
    mergeShellEnv(process.env, loginEnv?.vars ?? null) as Record<string, string>,
  ) as Record<string, string>
}

/** node-pty 的那部分 API（只用这几个）。 */
interface NodePtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pid: number
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd: string
      env: Record<string, string>
      /**
       * 用 **ConPTY**（Windows 10 1809+ 的伪控制台）？
       *
       * ⚠️ **必须显式给 true** —— node-pty 的默认值是
       * 「按 Windows 版本号猜」（`>= 18309` 才用 ConPTY）⇒ 版本判断一旦
       * 出错就悄悄退回 **winpty**（老式控制台代理，行为完全不同）。
       * ConPTY 才是我们要的：程序拿到**控制台设备**（`GetFileType == 2`）。
       */
      useConpty: boolean
    },
  ): NodePtyProcess
}

/**
 * 试着加载 node-pty —— **没有就返回 null**（不是抛异常）。
 *
 * ⚠️ 必须 try/catch：模块没装 / 装了但 ABI 对不上（没 rebuild），
 * `require` 都会抛 ⇒ 不能让终端因此起不来 ⇒ 退回管道版 ✓。
 */
export function tryLoadNodePty(): NodePtyModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node-pty') as NodePtyModule
  } catch {
    return null
  }
}

/**
 * 找一个**真的存在**的目录（当 cwd 用）。
 *
 * ⚠️ 为什么需要 —— `CreateProcess` 的 `lpCurrentDirectory` 不存在 ⇒ 进程起不来
 *    ⇒ node-pty 抛异常 ⇒ **整个终端静悄悄退成管道版** ⇒
 *    「终端一会真一会假」（用户报过）✓
 *
 * ⇒ 往上找一层一层的父目录 ⇒ 找到一个存在的就用它 ⇒
 *    真控制台**不会**因为「目录没了」而退化 ✓。
 */
export function existingDir(dir: string): string {
  const candidates: string[] = []
  let cur = resolve(dir)
  for (let i = 0; i < 8; i++) {
    candidates.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  candidates.push(process.cwd())
  candidates.push(homedir())
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c
    } catch {
      // 访问不了就试下一个
    }
  }
  return process.cwd()
}

/** node-pty 后端。 */
export class NodePtySession implements PtySession {
  private readonly proc: NodePtyProcess
  private exited = false
  private readonly batcher: OutputBatcher
  private readonly dataListeners: ((data: string) => void)[] = []
  private readonly exitListeners: ((code: number | null) => void)[] = []

  constructor(
    opts: PtySpawnOptions,
    nodePty: NodePtyModule,
  ) {
    this.batcher = new OutputBatcher((text) => {
      for (const cb of this.dataListeners) cb(text)
    })

    /*
     * ⚠️ 环境变量还是**登录 shell**那份（用户的 nvm/rbenv 在那儿）——
     * 真控制台也一样：用户在自己终端里能用的工具，IDE 的终端里也得能用。
     *
     * ⚠️ **但外部给了 env 就用它** —— 那是「pty 宿主进程」那条路：
     * 主进程已经把登录 shell 的 env 算好传进来了 ⇒ 宿主进程**不用**再起一个
     * 登录 shell 去导（那个活儿归主进程，它还缓存着）✓
     */
    const base = opts.env
      ? (process.env as Record<string, string>)
      : (mergeShellEnv(
          process.env,
          loadLoginShellEnvSync(opts.shell)?.vars ?? null,
        ) as Record<string, string>)
    const env = buildSubprocessEnv({
      ...base,
      ...(opts.env ?? {}),
    }) as Record<string, string>

    const spec = nodePtyCommand(opts)
    this.proc = nodePty.spawn(spec.exe, spec.args, {
      name: 'xterm-256color',
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
      // ⚠️ **cwd 必须真的存在** —— 不存在的话 `CreateProcess` 失败 ⇒
      //    node-pty 抛异常 ⇒ **整个终端静悄悄退成管道版** ⇒
      //    「终端一会真一会假」（用户报过）✓
      //    ⇒ 自己先兜住：往上找一个存在的目录（再不行用家目录）✓
      cwd: existingDir(opts.cwd),
      env,
      // ⚠️ **必须显式给 ConPTY**（见 `NodePtyModule` 里的说明）——
      //    否则 node-pty 按版本号猜，猜错就悄悄退回 winpty。
      useConpty: true,
    })

    this.proc.onData((data) => this.batcher.push(data))
    this.proc.onExit(({ exitCode }) => {
      this.batcher.flushNow()
      this.exited = true
      for (const cb of this.exitListeners) cb(exitCode)
    })
  }

  get running(): boolean {
    return !this.exited
  }

  /** 真控制台**自己会回显** ⇒ IDE 不要再回显一遍（否则每个字出现两次）。 */
  readonly echoesInput = true

  /** 这是真控制台版（ConPTY）。 */
  readonly backend = 'node-pty' as const

  /** 控制台的行编辑把 `\r`（回车键）当提交 ⇒ 行尾用 `\r`（**不能 `\r\n`**）。 */
  readonly lineEnding = '\r' as const

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb)
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitListeners.push(cb)
  }

  /** 写输入。 */
  write(data: string): void {
    if (this.exited) return
    try {
      this.proc.write(data)
    } catch {
      // 进程没了 —— 退出事件会跟上
    }
  }

  /**
   * 改窗口尺寸 ⇒ **真控制台能做实时改**（内核发 SIGWINCH）⇒
   * `vim` 分屏不会再错位 ✓（管道版做不到，见 `PipePtySession.resize`）。
   */
  resize(cols: number, rows: number): void {
    if (this.exited) return
    try {
      this.proc.resize(cols, rows)
    } catch {
      // 忽略
    }
  }

  /** 杀进程。 */
  async kill(): Promise<void> {
    if (this.exited) return
    this.exited = true
    this.batcher.dispose()
    try {
      this.proc.kill()
    } catch {
      // 已经没了
    }
  }
}

/** node-pty 起的是什么命令（shell 或「运行」按钮的程序）。 */
function nodePtyCommand(opts: PtySpawnOptions): { exe: string; args: string[] } {
  if (opts.command) return { exe: opts.command.exe, args: opts.command.args }
  switch (opts.shell as TerminalShell) {
    case 'cmd':
      return {
        exe: 'cmd.exe',
        // ⚠️ **有命令 ⇒ `/C`（跑完就退出）** ✓
        args: opts.shellCommand ? ['/Q', '/C', opts.shellCommand] : ['/Q'],
      }
    case 'powershell':
      return {
        exe: 'powershell.exe',
        args: opts.shellCommand
          ? shellCommandArgs('powershell', opts.shellCommand, {
              // ⚠️ **profile 的 env 已经注入到进程 env 里了** ⇒ 不用再加载 profile ✓
              noProfile: opts.noProfile,
            })
          : withShellIntegration('powershell', [
              '-NoLogo',
              // ⚠️ **不要 -NoProfile** —— 用户的 profile 里通常有 starship 之类 ⇒
              //    提示符才跟 VS Code 里一模一样（用户明说要「跟 VS Code 那个感觉」）✓
              '-NoExit',
              '-Command',
              '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
                '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
            ]),
      }
    case 'bash':
    default:
      // ⚠️ `--init-file` 注入 shell 集成（OSC 633）—— 详见 `shellIntegration.ts`
      // ⚠️ **有命令 ⇒ `-c`（跑完就退出）** ⇒ 不要 `-i`、也不要 init-file ✓
      return {
        exe: 'C:\\msys64\\usr\\bin\\bash.exe',
        args: opts.shellCommand
          ? shellCommandArgs('bash', opts.shellCommand)
          : withShellIntegration('bash', ['-i']),
      }
  }
}
