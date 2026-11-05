import { PtyHostCore, type PtyHostRequest } from './ptyHostCore'

/**
 * **pty 宿主进程**的入口 —— 这个文件跑在 Electron 的 `utilityProcess` 里
 * （**不是**主进程）。
 *
 * ## 它是什么
 *
 * 一个**独立的 Node 进程**，专门负责一件事：**管 node-pty**（真控制台 / ConPTY）。
 *
 * ## 为什么要单独一个进程
 *
 * 1. **node-pty 崩了不会把 IDE 带走** —— 它是原生模块，段错误就是整个
 *    Electron 进程死 ⇒ 用户的文件、Claude 会话、终端**全丢**。
 *    挪到独立进程里，它崩了只是终端没了，IDE 还活着 ✓
 * 2. **pty 的 I/O 不占主进程的事件循环** —— 主进程还管着编译器、
 *    Claude CLI、文件监听 ⇒ 终端狂打输出时不该把它们一起拖死 ✓
 *
 * （VS Code 也是这个架构：workbench → 共享进程 → **pty 宿主** → shell。）
 *
 * ## 这一层只有薄薄一层胶水
 *
 * 真正的逻辑在 `ptyHostCore.ts`（不依赖 Electron ⇒ 能在 Node 里单测）✓
 */

/** 宿主进程的核心逻辑。 */
const core = new PtyHostCore()

/** 把事件发回主进程。 */
core.onEvent((e) => {
  process.parentPort.postMessage(e)
})

/*
  ⚠️ **未捕获的异常也要报回主进程** ——

  宿主进程的 stdout **未必**能透到主进程的 stdout ⇒ 只 `console.error` 的话
  主进程**什么都看不见** ⇒ 终端就「没反应」而没人知道为什么 ✗
  ⇒ 全部发回主进程（主进程会打进日志）✓
*/
process.on('uncaughtException', (err) => {
  process.parentPort.postMessage({
    t: 'error',
    id: -1,
    error: `宿主进程未捕获的异常：${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  })
})
process.on('unhandledRejection', (reason) => {
  process.parentPort.postMessage({
    t: 'error',
    id: -1,
    error: `宿主进程未处理的 Promise 拒绝：${String(reason)}`,
  })
})

/** 收主进程的请求。 */
process.parentPort.on('message', (e) => {
  const req = e.data as PtyHostRequest
  if (process.env.JHY_PTY_HOST_DEBUG) {
    // ⚠️ **发回主进程**而不是 console.log ——
    //    宿主进程的 stdout 未必能透到主进程的 stdout ⇒ 看不见日志 ✗
    process.parentPort.postMessage({ t: 'debug', text: `收到请求：${req?.t ?? '?'}` })
  }
  if (!req || typeof req.t !== 'string') return
  try {
    core.handle(req)
  } catch (err) {
    // 请求处理炸了 ⇒ 告诉主进程（别让宿主进程自己静悄悄地死掉）
    process.parentPort.postMessage({
      t: 'error',
      id: 'id' in req ? req.id : -1,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

/*
  ⚠️⚠️ **启动就把原生模块加载进缓存** ——

  node-pty 的原生模块（`build/Release/conpty.node`）是**懒加载**的 ——
  `require('node-pty')` 根本不碰它，**第一次 spawn 时**才 require。

  而 **`npm install` 会把那个文件删掉**（node-pty 自己的 postinstall 有个
  bug：拿绝对路径去比相对文件名 ⇒ 比不中 ⇒ 把 `build/Release` 整个清空）
  ⇒ 那个窗口里起新终端就会失败 ⇒ **静悄悄退回管道版** ⇒
  **「终端一会真一会假的」**（用户报过）✓

  ⇒ 启动时先起一个「马上就退出」的真控制台 ⇒ 原生模块进模块缓存 ⇒
  之后文件被删也不影响 ✓（实测：预热前缓存里没有 `.node`，预热后有了）
*/
const warm = core.warmUp()

// 告诉主进程「我准备好了，而且 node-pty 在我这儿能不能用」
process.parentPort.postMessage({ t: 'ready', ok: warm.ok, error: warm.error })
