/**
 * **pty 宿主进程**的冒烟测试（不打开任何窗口 ⇒ 不抢用户的桌面）。
 *
 * ## 它验什么
 *
 * 单元测试只能验「协议」—— 真正危险的是 **Electron 那一层**：
 * - `utilityProcess.fork` 能不能把 `out/main/ptyHost.js` 起起来
 * - 宿主进程里的 `process.parentPort` 能不能跟主进程对上
 * - 宿主进程里的 node-pty 能不能起真控制台
 *
 * ⇒ 这三条都在这里真跑一遍 ✓
 *
 * ## 怎么跑
 *
 * ```bash
 * npm run build
 * npx electron scripts/pty-host-smoke.cjs
 * ```
 */
const { app, utilityProcess } = require('electron')
const { join } = require('node:path')

const root = join(__dirname, '..')
const script = join(root, 'out', 'main', 'ptyHost.js')

app.whenReady().then(async () => {
  console.log('[smoke] 起宿主进程：', script)
  // ⚠️ `JHY_PTY_HOST_DELAY` ⇒ 先空转这么久再发请求 ——
  //    用来验「宿主进程会不会自己死掉」（用户报过「长时间不理它会中断」）
  const delay = Number(process.env.JHY_PTY_HOST_DELAY ?? 0)
  const child = utilityProcess.fork(script, [], { serviceName: 'jhyy-pty-host' })

  let ready = false
  let sawData = false
  const output = []

  /** 起一个真控制台 ⇒ 打印一行就退出。 */
  const startSession = () =>
    child.postMessage({
      t: 'create',
      id: 1,
      spec: {
        shell: 'bash',
        cwd: root,
        cols: 80,
        rows: 24,
        // ⚠️ **必须摊平成普通对象** —— `process.env` 是**特殊对象**，
        //    结构化克隆**克隆不了** ⇒ `postMessage` 会直接抛
        //    「An object could not be cloned.」（实测踩过）✓
        env: { ...process.env },
        command: { exe: 'cmd.exe', args: ['/c', 'echo jhyy-host-smoke-ok'] },
      },
    })

  child.on('message', (message) => {
    if (message && message.t === 'ready') {
      ready = true
      console.log('[smoke] 宿主进程就绪：node-pty 可用 =', message.ok, message.error ?? '')
      if (delay > 0) {
        console.log(`[smoke] 空转 ${delay} ms 再发请求（验宿主进程会不会自己死掉）`)
        setTimeout(() => startSession(), delay)
        return
      }
      startSession()
      return
    }
    if (message && message.t === 'data') {
      sawData = true
      output.push(message.data)
      return
    }
    if (message && message.t === 'exit') {
      const text = output.join('')
      const ok = text.includes('jhyy-host-smoke-ok')
      console.log('[smoke] 拿到输出：', JSON.stringify(text.slice(0, 200)))
      console.log(ok ? '[smoke] ✅ 通过' : '[smoke] ❌ 没看到预期的输出')
      app.exit(ok ? 0 : 1)
      return
    }
    if (message && message.t === 'error') {
      console.error('[smoke] 宿主进程报错：', message.error)
      app.exit(1)
    }
    if (message && message.t === 'debug') {
      console.log('[smoke][debug]', message.text)
      return
    }
    if (message && message.t === 'created') {
      console.log('[smoke] 会话起来了 id =', message.id)
      return
    }
  })

  child.on('exit', (code) => {
    console.log('[smoke] 宿主进程退出了，代码', code, '（就绪过 =', ready, '）')
    if (!ready) {
      console.error('[smoke] ❌ 宿主进程还没就绪就退了，代码', code)
      app.exit(1)
    } else {
      app.exit(2)
    }
  })

  setTimeout(() => {
    console.error('[smoke] ❌ 超时了')
    app.exit(1)
  }, 20_000 + (Number(process.env.JHY_PTY_HOST_DELAY ?? 0) || 0))
})
