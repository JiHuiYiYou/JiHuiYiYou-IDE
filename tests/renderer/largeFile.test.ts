import { describe, expect, it } from 'vitest'
import {
  clampClaudeContextMaxKb,
  clampLargeFileThreshold,
  DEFAULT_CLAUDE_CONTEXT_MAX_KB,
  DEFAULT_LARGE_FILE_THRESHOLD,
  formatBytes,
  isLargeFile,
  MAX_CLAUDE_CONTEXT_MAX_KB,
  MAX_LARGE_FILE_THRESHOLD,
  MIN_CLAUDE_CONTEXT_MAX_KB,
  MIN_LARGE_FILE_THRESHOLD,
} from '../../src/renderer/editor/largeFile'

/**
 * **大文件模式** —— 超过阈值就自动关掉几样会「按文件大小付费」的功能。
 *
 * ⚠️ **这些是纯函数** ⇒ 不用起 IDE 就能测 ✓
 */
describe('大文件阈值', () => {
  it('默认是 1 MB', () => {
    expect(DEFAULT_LARGE_FILE_THRESHOLD).toBe(1024 * 1024)
  })

  it('**到**阈值就算大文件（不是超过）', () => {
    expect(isLargeFile(DEFAULT_LARGE_FILE_THRESHOLD - 1, DEFAULT_LARGE_FILE_THRESHOLD)).toBe(false)
    expect(isLargeFile(DEFAULT_LARGE_FILE_THRESHOLD, DEFAULT_LARGE_FILE_THRESHOLD)).toBe(true)
    expect(isLargeFile(DEFAULT_LARGE_FILE_THRESHOLD + 1, DEFAULT_LARGE_FILE_THRESHOLD)).toBe(true)
  })

  it('阈值不靠谱 ⇒ 夹到合理范围', () => {
    expect(clampLargeFileThreshold(0)).toBe(MIN_LARGE_FILE_THRESHOLD)
    expect(clampLargeFileThreshold(-1)).toBe(MIN_LARGE_FILE_THRESHOLD)
    expect(clampLargeFileThreshold(999 * 1024 * 1024)).toBe(MAX_LARGE_FILE_THRESHOLD)
    expect(clampLargeFileThreshold(Number.NaN)).toBe(DEFAULT_LARGE_FILE_THRESHOLD)
    expect(clampLargeFileThreshold(2 * 1024 * 1024)).toBe(2 * 1024 * 1024)
  })
})

describe('送进 Claude 的源码上限', () => {
  it('默认 256 KB', () => {
    expect(DEFAULT_CLAUDE_CONTEXT_MAX_KB).toBe(256)
  })

  it('不靠谱 ⇒ 夹到合理范围', () => {
    expect(clampClaudeContextMaxKb(0)).toBe(MIN_CLAUDE_CONTEXT_MAX_KB)
    expect(clampClaudeContextMaxKb(999999)).toBe(MAX_CLAUDE_CONTEXT_MAX_KB)
    expect(clampClaudeContextMaxKb(Number.NaN)).toBe(DEFAULT_CLAUDE_CONTEXT_MAX_KB)
    expect(clampClaudeContextMaxKb(512)).toBe(512)
  })
})

describe('字节数说成人话', () => {
  it('B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB')
  })
})
