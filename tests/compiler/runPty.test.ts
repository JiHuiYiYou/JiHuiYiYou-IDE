import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProgramInPty } from '../../src/main/runPty'

/**
 * 「运行」按钮跑程序的那条路（`runProgramInPty`）。
 *
 * ⚠️ **用户报过：「长时间不理它会程序中断，我不希望它中断」** ——
 *    那**不是程序自己中断的**，是 **IDE 的 60 秒超时把它杀了**：
 *    - 超时 ⇒ 杀掉整个 ConPTY ⇒ 前台程序收到 `CTRL_CLOSE_EVENT`
 *      ⇒ 退出码 `0xC000013A`（跟「用户按了 Ctrl+C」**一模一样**）
 *    - 而超时**没往上传** ⇒ 状态栏只能按退出码判 ⇒ 显示成「程序已中断」
 *      ⇒ **看着像程序自己断的** ✗
 *
 * ⇒ 现在：**默认不超时**（VS Code 的任务终端就是这样）+ 超时单独报 ✓
 */
describe('跑程序（真控制台）', () => {
  it('默认不超时：程序等多久都让它等（用户按「停止」才结束）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-run-'))
    // ⚠️ cmd.exe 不给指令就**一直等** ⇒ 正好当「长时间运行的程序」✓
    const p = runProgramInPty({
      exe: 'cmd.exe',
      cwd: dir,
      onOutput: () => {},
      // ⚠️ 不写任何东西 ⇒ 它不会自己退出 ⇒ 我们在下面手动收尾
      onStart: (write) => {
        setTimeout(() => write('exit\r'), 2500)
      },
    })
    const r = await p
    expect(r.timedOut).toBe(false)
    // ⚠️ **跑了 2.5 秒以上** ⇒ 说明中途没人杀它 ✓
    expect(r.durationMs).toBeGreaterThanOrEqual(2000)
  })

  it('真的超时了 ⇒ timedOut 为 true（跟「用户中断」分开报）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jhyy-run-'))
    const r = await runProgramInPty({
      exe: 'cmd.exe',
      cwd: dir,
      timeoutMs: 800,
      onOutput: () => {},
      // ⚠️ **什么都不写** ⇒ 它一直等 ⇒ 只能靠超时收场 ✓
    })
    expect(r.timedOut).toBe(true)
  })
})
