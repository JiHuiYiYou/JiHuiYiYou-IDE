import { tmpdir } from 'node:os'
import process from 'node:process'

/**
 * 构造子进程 env。
 *
 * 照抄 `mcp-jhyy/jhyy_env.py:build_subprocess_env()` 的配方 —— 那里的注释记录了
 * 踩过的坑，直接搬过来：
 *
 *   - gcc 的 `collect2` 需要 `TMP`/`TEMP` 才有临时目录可用
 *   - PATH 里得有个 **Windows 风格**的 MSYS2 目录。MSYS 风格的 `/c/msys64/ucrt64/bin`
 *     传给 jhyy.exe 内部的 cmd.exe 会坏掉 —— cmd.exe 不认 `/c/...` 虚拟路径，
 *     gcc 子进程（cc1/as/ld）找不到，表现为 **exit 1 且零输出**（"gcc link failed"）
 *   - `SystemRoot` / `SystemDrive` 缺失时部分系统调用会失败
 */

/** Windows 风格的兜底目录（追加在 PATH **末尾**）。 */
const WINDOWS_FALLBACK_DIRS = [
  'C:\\Windows\\System32',
  'C:\\Windows',
  'C:\\msys64\\ucrt64\\bin',
  'C:\\msys64\\usr\\bin',
]

/** ucrt64 的 bin —— gcc/cc1/as/ld 都在那儿。 */
const UCRT64_BIN = 'C:\\msys64\\ucrt64\\bin'

export function buildSubprocessEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }

  const fallbackTmp = tmpdir()
  if (!env.TMP) env.TMP = fallbackTmp
  if (!env.TEMP) env.TEMP = fallbackTmp
  if (!env.TMPDIR) env.TMPDIR = fallbackTmp
  if (!env.SystemRoot) env.SystemRoot = 'C:\\Windows'
  if (!env.SystemDrive) env.SystemDrive = 'C:'

  // ⚠️ **PATH 只「追加」，绝不「替换」**（语言仓库 W-156 的教训）。
  //
  // 早先的写法是"继承来的 PATH 看着像 MSYS 风格（/c/...）就整个换成 Windows 形式" ——
  // 那会把继承来的 PATH **一个字都丢掉**。语言仓库那边踩过：CI 上 setup-msys2 把
  // MSYS2 装在 `$RUNNER_TEMP\msys64`，ucrt64 就在那儿；整个替换掉 ⇒ windres 找不到
  // ⇒ **207/277 个测试全挂**（W-156）。
  //
  // 正确的做法：继承来的 PATH **原样保留**，只在**末尾**追加一份 Windows 形式的
  // MSYS2 目录当兜底 ⇒ 两种环境（MSYS 风格 / Windows 风格）都能用。
  //
  // ⚠️ Windows 的环境变量名大小写不敏感，但 JS 对象的键**区分**大小写 —— 继承来的
  // 键常常是 `Path`。直接写 `env.PATH` 会让 `Path` 和 `PATH` 两个键并存，
  // spawn 出来到底哪个生效说不准 ⇒ 先归一成**一个**键再改。
  const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')
  let rawPath: string | undefined
  if (extra) {
    const extraPathKey = Object.keys(extra).find((k) => k.toUpperCase() === 'PATH')
    if (extraPathKey) rawPath = extra[extraPathKey]
  }
  if (rawPath === undefined && pathKeys.length) rawPath = env[pathKeys[0]]
  const pathKey = pathKeys[0] ?? 'PATH'
  for (const k of pathKeys) if (k !== pathKey) delete env[k]

  const parts = (rawPath ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)

  // 编译器要 gcc 链接。ucrt64 的 gcc 排最前 —— PATH 里别处的 gcc 版本不对，
  // 挑错会 PE 链接失败（语言仓库 W-027 的根因之一）。
  if (!parts.some((p) => p.toLowerCase().endsWith('\\ucrt64\\bin'))) {
    parts.unshift(UCRT64_BIN)
  }

  // 兜底目录追加在末尾（不替换任何继承来的条目）。
  for (const dir of WINDOWS_FALLBACK_DIRS) {
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) parts.push(dir)
  }

  env[pathKey] = parts.join(';')

  return env
}
