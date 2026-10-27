import { watch, type FSWatcher } from 'node:fs'
import { extname, resolve } from 'node:path'

/**
 * 监听项目目录里 `.jhyy` 文件的变化。
 *
 * 用途：Claude Code 用 Edit/Write 改了磁盘上的文件 → IDE 要知道 → 提示用户
 * "文件在外部被改了"。**绝不静默覆盖用户编辑器里没保存的内容**。
 *
 * 用 Node 自带的 `fs.watch`（Windows 上支持 recursive），不引额外依赖。
 */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null
  private readonly onChanged: (path: string) => void

  constructor(onChanged: (path: string) => void) {
    this.onChanged = onChanged
  }

  /** 开始监听某个目录（递归）。 */
  start(dir: string): void {
    this.stop()
    try {
      this.watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return
        const name = String(filename)
        if (extname(name).toLowerCase() !== '.jhyy') return
        this.onChanged(resolve(dir, name))
      })
      this.watcher.on('error', () => {
        // 目录被删了之类 —— 忽略，别把 IDE 搞崩
      })
    } catch {
      // 监听不了就监听不了，不影响其它功能
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
