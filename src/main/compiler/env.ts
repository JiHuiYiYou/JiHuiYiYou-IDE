import { tmpdir } from 'node:os'
import process from 'node:process'

/**
 * 构造子进程 env。
 *
 * 照抄 `mcp-jhyy/jhyy_runner.py:_build_subprocess_env()` 的配方 —— 那里的注释记录了
 * 踩过的坑，直接搬过来：
 *
 *   - gcc 的 `collect2` 需要 `TMP`/`TEMP` 才有临时目录可用
 *   - PATH 必须是 **Windows 风格**。MSYS 风格的 `/c/msys64/ucrt64/bin` 传给
 *     jhyy.exe 内部的 cmd.exe 会坏掉 —— cmd.exe 不认 `/c/...` 虚拟路径，
 *     gcc 子进程（cc1/as/ld）找不到，表现为 **exit 1 且零输出**（"gcc link failed"）
 *   - `SystemRoot` / `SystemDrive` 缺失时部分系统调用会失败
 */
const WINDOWS_FALLBACK_PATH =
  'C:\\Windows\\System32;C:\\Windows;C:\\msys64\\ucrt64\\bin;C:\\msys64\\usr\\bin'
const UCRT64_BIN = 'C:\\msys64\\ucrt64\\bin'

export function buildSubprocessEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }

  const fallbackTmp = tmpdir()
  if (!env.TMP) env.TMP = fallbackTmp
  if (!env.TEMP) env.TEMP = fallbackTmp
  if (!env.TMPDIR) env.TMPDIR = fallbackTmp
  if (!env.SystemRoot) env.SystemRoot = 'C:\\Windows'
  if (!env.SystemDrive) env.SystemDrive = 'C:'

  // Windows 上 process.env 的键名大小写不敏感，这里统一读 PATH。
  const rawPath = env.PATH ?? env.Path ?? ''
  if (rawPath && !rawPath.startsWith('/')) {
    // 已经是 Windows 风格 —— 把 ucrt64 补到最前面（gcc/cc1/as/ld 都在那里）
    if (!rawPath.toLowerCase().includes(UCRT64_BIN.toLowerCase())) {
      env.PATH = `${UCRT64_BIN};${rawPath}`
    }
  } else {
    // 空 / MSYS 风格（/c/...）—— 强制换成 Windows 风格
    env.PATH = WINDOWS_FALLBACK_PATH
  }

  return env
}
