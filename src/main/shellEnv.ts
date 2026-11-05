import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import type { TerminalShell } from '@shared/terminal'

const execFileAsync = promisify(execFile)

/**
 * 登录 shell 的环境变量。
 *
 * ## 为什么需要它
 *
 * IDE 起的 shell **不是登录 shell** ⇒ 它继承的是 **IDE 自己**的环境，
 * 而 IDE 是从 Explorer 之类的地方启动的 ⇒ 用户在 `.bashrc` / `.bash_profile`
 * 里加的东西（**nvm、rbenv、pyenv、sdkman、conda init、PATH 上的自建工具**）
 * **一个都没有**。
 *
 * ⇒ 表现就是「终端里 node 找不到」「python 是另一个版本」「go 不在了」。
 *
 * ## 怎么拿
 *
 * 起一个**登录 shell** 让它把 env 倒出来：
 * - bash：`bash -lc 'env -0'`（NUL 分隔 ⇒ 值里有换行也不怕）
 * - cmd：`cmd /c set`（`KEY=VALUE` 一行一个）
 * - powershell：跳过（登录语义太怪，不值得为它写一套）
 *
 * 拿到的结果**缓存**起来（导一次要 ~0.5-1 秒），而且**在 IDE 生命周期内只导一次**
 * —— 用户改完 `.bashrc` 要重启 IDE 才生效（跟 VS Code 的 terminal 环境
 * 缓存周期是一个量级；VS Code 有个「重新加载窗口」按钮，我们靠重启）。
 */

/** 一次导出的结果。 */
export interface ShellEnv {
  /** shell 吐出来的环境变量 */
  vars: Record<string, string>
  /** 是哪个 shell 导的（排障用） */
  source: TerminalShell
}

/** 每个 shell 导一次，缓存住。 */
const cache = new Map<TerminalShell, ShellEnv>()

/**
 * **同步**取缓存里的登录 shell 环境（导不到就 null）。
 *
 * ⚠️ 为什么要有同步版：`TerminalSession.start()` 是同步的（终端面板的启动
 * 路径不希望等一次 IPC 往返）⇒ 只能读**已经导好**的缓存。
 *
 * ⇒ IDE 启动时就在后台导一次（`main/index.ts`）⇒ 等用户真开终端时早有了 ✓。
 */
export function loadLoginShellEnvSync(shell: TerminalShell): ShellEnv | null {
  return cache.get(shell) ?? null
}

/** 导出超时（秒）—— 登录 shell 要是卡住（等密码之类），不能把 IDE 拖死。 */
const EXPORT_TIMEOUT_MS = 6_000

/**
 * **PowerShell 的导出超时** —— 得宽松得多。
 *
 * ⚠️ **PowerShell 的 profile 可能非常慢** —— 这台机器上用户的 profile 里有
 *    `conda init`（它要起一个 conda.exe 跑 hook）⇒ **实测 9～11 秒** ✗
 * ⇒ 用 6 秒的超时 ⇒ **每次都导失败** ⇒ 环境变量永远拿不到 ✗
 * ⇒ ⇒ 给它 30 秒 ✓（反正是在**后台**导的，不挡启动）
 */
const POWERSHELL_EXPORT_TIMEOUT_MS = 30_000

/**
 * **PowerShell 的环境变量导出命令**。
 *
 * ⚠️ **不 dot-source profile** —— 让 PowerShell **自己**加载它（默认行为）⇒
 *    加载完再把 env 倒出来 ⇒ 拿到的就是「用户在自己终端里看到的」那份 env ✓
 *    （conda 的 PATH、`CONDA_PREFIX` 都在里面 ✓）
 *
 * ⚠️ **用 NUL 分隔** —— 环境变量的值里可能有换行 ⇒ 按行切会串 ✓
 * ⚠️ **显式设 UTF-8** —— Windows 上 PowerShell 的输出默认是 OEM 代码页（GBK）
 *    ⇒ 中文路径会变乱码 ⇒ 后面按 UTF-8 解就炸了 ✓
 */
const POWERSHELL_DUMP_ENV =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  '[Console]::Out.Write(((Get-ChildItem Env: | ForEach-Object { $_.Name + "=" + $_.Value }) -join [char]0))'

/**
 * 拿登录 shell 的环境（带缓存）。
 *
 * ⚠️ **失败不抛** —— 导不到就用 IDE 自己的环境（现在的行为），
 * 终端照样能开，只是少了用户 profile 里的那些路径。
 */
export async function loadLoginShellEnv(shell: TerminalShell): Promise<ShellEnv | null> {
  const cached = cache.get(shell)
  if (cached) return cached

  let vars: Record<string, string> | null = null
  try {
    vars = await exportEnv(shell)
  } catch {
    vars = null
  }
  if (!vars || Object.keys(vars).length === 0) {
    // ⚠️ **不缓存失败** —— 导失败可能是暂时的（shell 还没准备好），
    // 下次再试一次。
    return null
  }
  const result: ShellEnv = { vars, source: shell }
  cache.set(shell, result)
  return result
}

/** 忘掉缓存（下次调用重新导）。 */
export function clearShellEnvCache(): void {
  cache.clear()
}

/** 起一个登录 shell 把 env 倒出来。 */
async function exportEnv(shell: TerminalShell): Promise<Record<string, string> | null> {
  switch (shell) {
    case 'bash':
    case 'cmd':
    case 'powershell':
      break
  }
  if (shell === 'bash') {
    // `env -0` 用 NUL 分隔 ⇒ 值里带换行也不会串行
    const { stdout } = await execFileAsync(
      'C:\\msys64\\usr\\bin\\bash.exe',
      ['-lc', 'env -0'],
      {
        timeout: EXPORT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'buffer',
      },
    )
    return parseNulEnv(stdout.toString('utf8'))
  }
  if (shell === 'cmd') {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', 'set'], {
      timeout: EXPORT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return parseSetEnv(stdout)
  }
  if (shell === 'powershell') {
    /*
      ⚠️⚠️ **PowerShell 的 profile 也要导** ——
        「登录语义」跟 bash/cmd 差太远（那部分先不导），
        但 **profile 的环境变量**（用户的 conda init 就在那儿）是**要**的 ⇒
        ⇒ 让 PowerShell **自己**加载 profile，再把 env 倒出来 ✓

      ⚠️ **这一步很慢**（这台机器 ~10 秒，conda init）⇒
        ⇒ 它是**后台**导的（IDE 启动时就开始）⇒ 不挡启动 ✓
        ⇒ 而且**只导一次** ⇒ 后面都从缓存拿 ✓
    */
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-Command', POWERSHELL_DUMP_ENV],
      {
        timeout: POWERSHELL_EXPORT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env },
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
    )
    return parseNulEnv(stdout)
  }
  return null
}

/** `env -0` 的输出（NUL 分隔）⇒ 变量表。 */
export function parseNulEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

/** `cmd /c set` 的输出（一行一个 `KEY=VALUE`）⇒ 变量表。 */
export function parseSetEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

/**
 * 把登录 shell 的环境**叠到**要传给子进程的环境上。
 *
 * ⚠️ **顺序要紧**：先叠 shell 的（用户的 nvm/rbenv/PATH 都在那儿），
 * **再**走 `buildSubprocessEnv()`（它负责 TMP/SystemRoot 和 PATH 的
 * Windows 风格兜底）—— 反过来的话，用户的 PATH 会被 IDE 的修复覆盖掉。
 */
export function mergeShellEnv(
  base: NodeJS.ProcessEnv,
  vars: Record<string, string> | null,
): NodeJS.ProcessEnv {
  if (!vars) return base
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [k, v] of Object.entries(vars)) {
    /*
      ⚠️⚠️ **PATH 的键名大小写可能不一样** ——
        Windows 上 `process.env` 里常见的是 `Path`，而导出来的 env 里是 `PATH`
        ⇒ 两份**并存** ⇒ 后面 `buildSubprocessEnv` 挑「第一个」⇒
        ⇒ **挑到的是继承来的那份** ⇒ **用户 PATH 白导了** ✗
        ⇒ ⇒ 先把别的 PATH 变体删掉，只留这个 ✓
    */
    if (k.toUpperCase() === 'PATH') {
      for (const old of Object.keys(merged)) {
        if (old.toUpperCase() === 'PATH' && old !== k) delete merged[old]
      }
    }
    merged[k] = v
  }
  return merged
}
