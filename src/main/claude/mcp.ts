import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 给内嵌的 Claude 挂上 **jhyy MCP server**。
 *
 * 为什么重要：Claude Code 见过的语言只有 Python/JS/TS，它不会写 JHYY。
 * 但挂上这个 MCP server 之后，它能调 `jhyy_check` / `jhyy_run` / `jhyy_lang_ref`
 * 拿到**真实编译器的诊断** —— 于是它能自己写、自己编译、看报错、改对。
 * 这是让 Claude 在这门语言上真正帮上忙的关键。
 *
 * 配置来源：优先**复用用户 `~/.claude.json` 里已经配好的 `jhyy` 条目**
 * （用户机器上已经有一个能用的），这样用户改了 MCP 配置 IDE 自动跟随。
 * 找不到就自己找语言仓库里的 `mcp-jhyy/server.py`。
 */

/** `~/.claude.json` 里的 mcpServers 条目形状。 */
interface McpServerEntry {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export async function buildMcpConfig(): Promise<string | null> {
  const servers = collectMcpServers()
  const jhyy = servers.jhyy
  if (!jhyy || !jhyy.command) return null

  const config = { mcpServers: { jhyy } }
  const dir = mkdtempSync(join(tmpdir(), 'jhyy-ide-mcp-'))
  const file = join(dir, 'mcp.json')
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  return file
}

/** 收集可用的 MCP server 配置。 */
function collectMcpServers(): Record<string, McpServerEntry> {
  // ① 用户已有的配置
  const userConfig = join(homedir(), '.claude.json')
  if (existsSync(userConfig)) {
    try {
      const parsed = JSON.parse(readFileSync(userConfig, 'utf8')) as {
        mcpServers?: Record<string, McpServerEntry>
      }
      if (parsed.mcpServers?.jhyy) return parsed.mcpServers
    } catch {
      /* 配置坏了就当没有 */
    }
  }

  // ② 自己找语言仓库里的 mcp-jhyy/server.py
  const serverScript = findMcpServerScript()
  if (!serverScript) return {}

  const python = findPythonWithFastMcp()
  if (!python) return {}

  return {
    jhyy: {
      type: 'stdio',
      command: python,
      args: [serverScript],
      env: {},
    },
  }
}

/** 在常见位置找语言仓库的 `mcp-jhyy/server.py`。 */
function findMcpServerScript(): string | null {
  const roots = [
    // IDE 仓库的兄弟目录
    resolve(process.cwd(), '..', 'JiHuiYiYou'),
    resolve(homedir(), 'Desktop', 'coding', 'JiHuiYiYou'),
  ]
  for (const root of roots) {
    const candidate = join(root, 'mcp-jhyy', 'server.py')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 找一个装了 fastmcp 的 python。
 *
 * ⚠️ PATH 上的 `python` 未必有 —— 用户机器上 `C:\msys64\mingw64\bin\python.exe`
 * 就**没有** fastmcp（用它是 MCP server 直接起不来）。miniconda 那个有。
 */
let cachedPython: string | null | undefined

function findPythonWithFastMcp(): string | null {
  if (cachedPython !== undefined) return cachedPython

  const candidates = [
    process.env.PYTHON_FOR_MCP,
    join(homedir(), 'miniconda3', 'python.exe'),
    join(homedir(), 'anaconda3', 'python.exe'),
    'python',
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    try {
      // 用最省事的方式判断：能不能 import fastmcp
      execFileSync(candidate, ['-c', 'import fastmcp'], { stdio: 'ignore', timeout: 10_000 })
      cachedPython = candidate
      return candidate
    } catch {
      /* 这个 python 没有 fastmcp，试下一个 */
    }
  }
  cachedPython = null
  return null
}
