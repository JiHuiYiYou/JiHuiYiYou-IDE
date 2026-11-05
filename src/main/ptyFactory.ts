import type { PtyBackendInfo } from '@shared/terminal'
import { PipePtySession } from './ptyPipe'
import { ensurePtyHost } from './ptyHostClient'
import { NodePtySession, tryLoadNodePty } from './ptyNode'
import { loadLoginShellEnvSync } from './shellEnv'
import type { PtySession, PtySpawnOptions } from './pty'

/**
 * 挑一个终端后端。
 *
 * ## 优先级
 *
 * 1. **pty 宿主进程**（真控制台跑在**独立进程**里）⇒ 程序拿到控制台 ⇒
 *    `isatty(1)` 为 TRUE ⇒ C 运行时**不缓冲** stdout ⇒ 交互式程序的提示
 *    立刻可见；`vim`/`top` 能跑；窗口尺寸实时对得上 ✓。
 *    ⇒ 而且 **node-pty 崩了不会把 IDE 带走**（原生模块段错误 = 整个
 *    Electron 进程死）✓
 * 2. **主进程里直接跑 node-pty** ⇒ 宿主进程起不来时的退路 ✓
 * 3. **管道**（`child_process.spawn`）⇒ 兜底：node-pty 没装（原生模块要按
 *    Electron 的 ABI 重新编译 ⇒ 要 MSVC）时也能用，只是没有真控制台那些好处。
 *
 * ⚠️ **不能让 node-pty 变成硬依赖** —— 它装不上时 `npm install` 直接失败，
 *    整个 IDE 就没法装了 ⇒ 所以它是**可选的**，用动态 require 探（探不到就
 *    退回管道）✓。
 *
 * ⚠️ **退化必须是「看得见」的** —— 以前这里是 `catch {}`（静悄悄）⇒
 *    node-pty 哪天起不来，用户只会看到「终端怎么又变假了」（用户报过
 *    「终端一会真一会假的」）⇒ 现在：**记下原因 + 打进日志 + 状态栏显示徽章** ✓。
 */

/** 这台机器现在的后端状态（给状态栏 / IPC 用）。 */
let backendInfo: PtyBackendInfo = { backend: 'pipe' }

/** 记下后端状态。退到管道版时**一定**要说一声（不然就是「悄悄变假」）。 */
export function reportPtyBackend(info: PtyBackendInfo): void {
  backendInfo = info
  if (info.backend === 'pipe') {
    console.error(
      `[pty] ⚠️ 终端只能用管道版（不是真控制台）：${info.reason ?? '未知原因'}` +
        ' —— 跑一次 `npm install` 让 postinstall 把 node-pty 按 Electron 的 ABI 编出来。',
    )
  }
}

/** 现在是哪个后端（状态栏显示 / 排障）。 */
export function ptyBackendInfo(): PtyBackendInfo {
  return backendInfo
}

export function createPtySession(rawOpts: PtySpawnOptions): PtySession {
  const want = rawOpts.backend ?? 'auto'

  /*
    ⚠️⚠️ **「别加载 profile」** ——
      **用户的 PowerShell profile 可能要 9～11 秒**（这台机器上是 `conda init`）
      ⇒ 「运行」/「检查」每次都等它 ⇒ **按钮点了半天才有反应** ✗
    ⇒ ⇒ VS Code 的任务终端是 `useShellEnvironment = true` ⇒
      用的是**算好的** shell 环境，**不重新跑 profile** ✓
    ⇒ ⇒ 所以：**profile 的 env 导到了 ⇒ 就别再加载它** ✓
    ⚠️ **导不到就不加这个标志** ⇒ 不然用户的 conda 就没了（宁可慢）✓
  */
  const noProfile =
    rawOpts.shellCommand !== undefined &&
    rawOpts.shell === 'powershell' &&
    loadLoginShellEnvSync(rawOpts.shell) !== null
  const opts: PtySpawnOptions = noProfile ? { ...rawOpts, noProfile: true } : rawOpts

  if (want === 'pipe') return new PipePtySession(opts)

  // ① **pty 宿主进程**（首选）—— 真控制台跑在独立进程里 ⇒
  //    node-pty 崩了不会把整个 IDE 带走 ✓
  const host = ensurePtyHost()
  // ⚠️ **宿主崩过 ⇒ 重新起一个** —— 不然 `available` 永远 false
  //    ⇒ 之后所有终端都退回「主进程里跑 node-pty」⇒ 段错误会带走整个 IDE ✗
  host?.ensureStarted()
  /*
    ⚠️ **用 `canCreate`，不是 `available`** ——
       `available` 要求宿主**已经报过 ready**（那要它自己起来、加载 node-pty、
       预热一个控制台 ⇒ 好几百毫秒）⇒ **IDE 刚启动时的第一个终端**正好落在这个
       窗口里 ⇒ 以前它会退回「主进程里跑 node-pty」⇒ **没有崩溃隔离** ✗
       ⇒ `canCreate` 允许「还没 ready」的宿主（请求先攒着，ready 之后发）✓
  */
  if (host?.canCreate) {
    try {
      const session = host.create({
        shell: opts.shell,
        cwd: opts.cwd,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 30,
        ...(opts.command ? { command: opts.command } : {}),
        /*
          ⚠️⚠️⚠️ **「让 shell 跑这一条命令然后退出」必须传过去** ——
            不传 ⇒ 宿主起的是**普通交互 shell** ⇒ **那条命令压根没跑** ⇒
            ⇒ **终端里一点程序输出都没有**（用户报过）✗
            ⇒ 而且终端永远不退出 ⇒ 「运行中」永远亮着 ✗
            ⇒ ⚠️ 只有这条路会坏 ⇒ **装没装 node-pty 决定「运行」坏不坏** ✗
        */
        ...(opts.shellCommand ? { shellCommand: opts.shellCommand } : {}),
        ...(noProfile ? { noProfile } : {}),
      })
      reportPtyBackend({ backend: 'node-pty' })
      return session
    } catch (err) {
      // 宿主进程那边起不来 ⇒ 落到 ②
      console.warn(`[pty] 宿主进程起会话失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ② **主进程里直接跑 node-pty**（宿主进程不可用时的退路）
  const nodePty = tryLoadNodePty()
  if (!nodePty) {
    reportPtyBackend({ backend: 'pipe', reason: 'node-pty 模块没装（可选依赖没装上？）' })
    return new PipePtySession(opts)
  }
  try {
    const session = new NodePtySession(opts, nodePty)
    reportPtyBackend({ backend: 'node-pty' })
    return session
  } catch (err) {
    // 起不来（原生模块加载不了 / cwd 不存在 / 句柄不够 …）⇒ 退回管道版
    reportPtyBackend({
      backend: 'pipe',
      reason: err instanceof Error ? err.message : String(err),
    })
    return new PipePtySession(opts)
  }
}
