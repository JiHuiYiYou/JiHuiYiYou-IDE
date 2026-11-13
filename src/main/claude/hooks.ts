import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Claude Code 的 **PostToolUse hook** —— 模型一写完 `.jhyy`，**IDE 立刻编译，
 * 把真实诊断喂回上下文**。
 *
 * ## 为什么值得做
 *
 * 评测的轨迹归因（`scripts/eval/analyze-turns.ts`，32 道题）测出：
 * **「验证」占了 31~34% 的轮数**，其中「模型自己想起来要去编译」这一段
 * **可以由系统代劳**。
 *
 * ⇒ 跟「在 prompt 里叮嘱模型记得验」是本质区别：
 * **从「靠模型的自觉」变成「系统的保证」**。
 *
 * ## 钩子脚本放哪
 *
 * ⚠️ **必须放在 asar 外面** —— Electron 的 asar 里的文件**没法被外部 node 执行**
 * （`node xxx.asar/scripts/...` 会失败）。
 * ⇒ 打包时用 `extraResources` 放到 `resources/` 下；
 *   开发时用仓库里的 `scripts/jhyy-check-hook.mjs`。
 *
 * ## 钩子绝不能阻断会话
 *
 * 钩子脚本**永远 exit 0** —— 它只**提供信息**，不阻断。
 * （阻断要用 exit 2，那会让 IDE 看起来卡死。）
 */

export interface HookSettingsOptions {
  /** 编译器可执行文件路径 */
  compilerPath: string
  /** 钩子脚本路径（开发时在仓库里，打包后在 resources/ 下） */
  scriptPath: string
  /** 跑钩子的 node 可执行文件（默认 `node`） */
  nodePath?: string
}

/**
 * 给命令参数加引号。
 *
 * ⚠️ **路径必须换成正斜杠** —— 这是**实测踩出来的坑**：
 *   CLI 跑 hook 命令时**经过 shell**（git-bash / sh）⇒
 *   **反斜杠在 sh 里是转义字符** ⇒ `C:\Users\liuzhen\...` 会被解析成
 *   `C:Usersliuzhen...` ⇒ **命令找不到文件 ⇒ hook 静默死掉**
 *   （现象：hook 日志文件连创建都没有，模型也没拿到任何诊断）。
 *   ⇒ Windows 的 API **接受正斜杠** ⇒ 统一转成 `/` 就好。
 */
function quote(arg: string): string {
  const p = arg.replace(/\\/g, '/')
  return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p
}

/**
 * 生成一份临时的 `settings.json`，返回它的路径（给 `--settings` 用）。
 *
 * ⚠️ Claude Code 的 `--settings` 是**叠加**在 user/project settings 之上的，
 *   不会覆盖它们 ✓（我们只是加一个钩子）。
 */
export function buildHookSettings(opts: HookSettingsOptions): string {
  const node = opts.nodePath ?? 'node'
  const command = [quote(node), quote(opts.scriptPath), quote(opts.compilerPath)].join(' ')

  const settings = {
    hooks: {
      PostToolUse: [
        {
          // 只在「改了文件」之后触发
          matcher: 'Write|Edit|MultiEdit',
          hooks: [{ type: 'command', command }],
        },
      ],
    },
  }

  const dir = mkdtempSync(join(tmpdir(), 'jhyy-ide-hooks-'))
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8')
  return file
}

/**
 * 找钩子脚本：打包后在 `resources/` 下，开发时在仓库 `scripts/` 下。
 */
export function findHookScript(appPath: string, resourcesPath: string): string | null {
  const candidates = [
    join(resourcesPath, 'jhyy-check-hook.mjs'),
    join(appPath, 'scripts', 'jhyy-check-hook.mjs'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}
