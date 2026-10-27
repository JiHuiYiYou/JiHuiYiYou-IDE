import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 找 Claude Code 的**原生可执行文件**。
 *
 * ⚠️ PATH 上的 `claude` 是 npm 的 shim（`claude.cmd` + 一个 sh 脚本），
 * 它 exec 的是真正的原生 exe：
 *     <npm root>/node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *
 * 直接 spawn 那个 `.exe`（`shell: false`）能绕开 Windows 上 `.cmd` 必须走
 * shell 的限制（Node 18.20.2+ 之后 spawn `.cmd` 不带 shell 会直接报 EINVAL）。
 */
export interface ClaudeBinary {
  path: string
  version?: string
}

/** 从一个 npm root 里找原生 exe。 */
function findInNpmRoot(npmRoot: string): string | null {
  const candidate = join(
    npmRoot,
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  )
  return existsSync(candidate) ? candidate : null
}

/** 从 PATH 上的 `claude.cmd` 反推 npm root。 */
function npmRootFromShim(shimPath: string): string | null {
  // <root>/node_modules/@anthropic-ai/claude-code/... → 往回退 4 层
  let dir = shimPath
  for (let i = 0; i < 4; i++) {
    const parent = join(dir, '..')
    const normalized = parent
    if (existsSync(join(normalized, 'node_modules', '@anthropic-ai', 'claude-code'))) {
      return normalized
    }
    dir = parent
  }
  return null
}

/** 列出 PATH 上所有 claude 的候选位置。 */
function claudeCandidatesOnPath(): string[] {
  const out: string[] = []
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of ['claude.exe', 'claude.cmd', 'claude']) {
      const p = join(dir, name)
      if (existsSync(p)) out.push(p)
    }
  }
  return out
}

/** 常见的 npm 全局安装位置。 */
function commonNpmRoots(): string[] {
  const roots: string[] = []
  const appData = process.env.APPDATA
  if (appData) roots.push(join(appData, 'npm'))
  const home = process.env.USERPROFILE
  if (home) {
    roots.push(join(home, '.npm-global'))
    roots.push(join(home, 'AppData', 'Roaming', 'npm'))
    roots.push(join(home, '.local', 'lib', 'node_modules'))
  }
  // 用户机器上 claude 装在 miniconda3 里
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) roots.push(join(localAppData, 'Programs'))
  return roots
}

/** 定位 Claude Code 的原生可执行文件。 */
export async function locateClaude(): Promise<ClaudeBinary | null> {
  const candidates: string[] = []

  if (process.env.CLAUDE_BIN) candidates.push(process.env.CLAUDE_BIN)

  // PATH 上的 shim → 反推 npm root
  for (const shim of claudeCandidatesOnPath()) {
    const root = npmRootFromShim(shim)
    if (root) {
      const exe = findInNpmRoot(root)
      if (exe) candidates.push(exe)
    }
    if (shim.endsWith('.exe')) candidates.push(shim)
  }

  // 常见安装位置
  for (const root of commonNpmRoots()) {
    const exe = findInNpmRoot(root)
    if (exe) candidates.push(exe)
  }

  // 去重，取第一个存在的
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c)) continue
    seen.add(c)
    if (!existsSync(c)) continue

    let version: string | undefined
    try {
      const { stdout } = await execFileAsync(c, ['--version'], {
        timeout: 15_000,
        windowsHide: true,
      })
      version = stdout.trim().split('\n')[0]
    } catch {
      // 拿不到版本号也不影响用
    }
    return { path: c, version }
  }

  return null
}

/** 列出某个目录下所有 `claude` 相关的可执行文件（调试用）。 */
export function debugClaudeCandidates(): string[] {
  return claudeCandidatesOnPath()
}
