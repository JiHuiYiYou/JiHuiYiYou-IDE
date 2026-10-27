import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import type { ToolchainInfo } from '@shared/jhyy'
import { buildSubprocessEnv } from './env'

const execFileAsync = promisify(execFile)

/** 语言仓库在磁盘上的名字（IDE 仓库的兄弟目录）。 */
const LANG_REPO_DIRNAME = 'JiHuiYiYou'

/**
 * 候选来源，按优先级排列。
 *
 * 注意顺序：**开发构建排在官方安装前面**。
 * - 开发构建 `JiHuiYiYou/compiler/build/bin/jhyy.exe` 能解析标准库
 *   （走源码树布局，stdlib 在 `compiler/src0/std/`）
 * - 官方安装 `C:\Program Files\JHYY\bin\jhyy.exe` 走安装布局，stdlib 应该在
 *   `<bin>/std/`，但**本机那份并没有这个目录** → `import vec;` 之类会失败
 */
export interface Candidate {
  exePath: string
  source: ToolchainInfo['source']
}

/**
 * 从 IDE 仓库根目录往上找语言仓库的开发构建。
 * IDE 仓库 `JiHuiYiYou-IDE` 与语言仓库 `JiHuiYiYou` 通常是兄弟目录。
 */
export function findDevBuild(repoRoot: string): string | null {
  let dir = resolve(repoRoot)
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, LANG_REPO_DIRNAME, 'compiler', 'build', 'bin', 'jhyy.exe')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 列出所有候选，按优先级从高到低。 */
export function listCandidates(repoRoot: string, override?: string): Candidate[] {
  const out: Candidate[] = []

  if (override) out.push({ exePath: override, source: 'setting' })

  const fromEnv = process.env.JHY_EXE
  if (fromEnv) out.push({ exePath: fromEnv, source: 'env' })

  const devBuild = findDevBuild(repoRoot)
  if (devBuild) out.push({ exePath: devBuild, source: 'dev-build' })

  const installed = 'C:\\Program Files\\JHYY\\bin\\jhyy.exe'
  if (existsSync(installed)) out.push({ exePath: installed, source: 'installed' })

  out.push({ exePath: 'jhyy.exe', source: 'path' })

  return out
}

/**
 * 探测一个 jhyy.exe 是否可用。
 *
 * ⚠️ 必须用 `--help`（exit 0）探测，**不能**用 `--version` ——
 * 编译器不支持 `--version`，会打印 "unknown command" 并 exit 1。
 */
export async function probeJhyy(exePath: string): Promise<{ ok: boolean; versionText?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(exePath, ['--help'], {
      windowsHide: true,
      timeout: 10_000,
      env: buildSubprocessEnv(),
      maxBuffer: 4 * 1024 * 1024,
    })
    // --help 打印到 stdout，第一行是 "jhyy compiler vX.Y.Z (...)"
    const firstLine = `${stdout}${stderr}`.split(/\r?\n/).find((l) => l.trim().length > 0)
    return { ok: true, versionText: firstLine?.trim() }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    const detail = e.stderr?.trim() || e.message
    return { ok: false, error: detail }
  }
}

/** 按优先级找到第一个可用的 jhyy.exe。 */
export async function locateJhyy(repoRoot: string, override?: string): Promise<ToolchainInfo> {
  const candidates = listCandidates(repoRoot, override)
  const failures: string[] = []

  for (const candidate of candidates) {
    // PATH 上的候选没有绝对路径，交给 probe 去解析
    const probe = await probeJhyy(candidate.exePath)
    if (probe.ok) {
      return {
        exePath: candidate.exePath,
        source: candidate.source,
        available: true,
        versionText: probe.versionText,
      }
    }
    failures.push(`${candidate.exePath}: ${probe.error ?? 'unavailable'}`)
  }

  return {
    exePath: candidates[0]?.exePath ?? 'jhyy.exe',
    source: candidates[0]?.source ?? 'path',
    available: false,
    error: failures.join('\n'),
  }
}
