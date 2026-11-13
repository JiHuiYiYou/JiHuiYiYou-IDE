/**
 * 评测轨迹解析的单测 —— **门 2（mock 自检）**。
 *
 * 这一层**不花钱、不调 API**，纯逻辑 ⇒ 每次提交都能跑。
 *
 * ⚠️ 重点覆盖一个实测踩过的坑：**路径分隔符不一致** ——
 * 模型给的 `file_path` 用正斜杠，`join()` 出来的是反斜杠
 * ⇒ 只归一化一边 ⇒ 模型改了文件但我们没看见 ⇒ **评测把对的判成错的**。
 */

import { describe, expect, it } from 'vitest'

import {
  extractCodeFromAnswer,
  normPath,
  parseStream,
  reconstructVersions,
  usedCompiler,
} from '../../scripts/eval/trajectory'

describe('normPath', () => {
  it('正斜杠与反斜杠归一化成同一个 key', () => {
    expect(normPath('C:\\tmp\\a\\b.jhyy')).toBe(normPath('c:/tmp/a/b.jhyy'))
  })
})

describe('reconstructVersions', () => {
  const initial = 'fn main_jhyy() -> i32 {\n    return 0;\n}\n'

  it('⚠️ 分隔符不一致也要认出来（实测踩过的坑）', () => {
    const target = 'C:\\tmp\\ws\\main.jhyy'
    const versions = reconstructVersions(
      [{ name: 'Write', input: { file_path: 'C:/tmp/ws/main.jhyy', content: 'FIXED' } }],
      target,
      initial,
    )
    expect(versions).toHaveLength(2)
    expect(versions[1]).toBe('FIXED')
  })

  it('Write 记一版', () => {
    const versions = reconstructVersions(
      [{ name: 'Write', input: { file_path: '/ws/main.jhyy', content: 'V1' } }],
      '/ws/main.jhyy',
      initial,
    )
    expect(versions).toEqual([initial, 'V1'])
  })

  it('Edit 重放 old→new', () => {
    const versions = reconstructVersions(
      [
        {
          name: 'Edit',
          input: { file_path: '/ws/main.jhyy', old_string: 'return 0;', new_string: 'return 1;' },
        },
      ],
      '/ws/main.jhyy',
      initial,
    )
    expect(versions).toHaveLength(2)
    expect(versions[1]).toContain('return 1;')
  })

  it('MultiEdit 按顺序重放每一条', () => {
    const versions = reconstructVersions(
      [
        {
          name: 'MultiEdit',
          input: {
            file_path: '/ws/main.jhyy',
            edits: [
              { old_string: 'return 0;', new_string: 'return 1;' },
              { old_string: 'return 1;', new_string: 'return 2;' },
            ],
          },
        },
      ],
      '/ws/main.jhyy',
      initial,
    )
    expect(versions[1]).toContain('return 2;')
  })

  it('改别的文件不算数', () => {
    const versions = reconstructVersions(
      [{ name: 'Write', input: { file_path: '/ws/other.jhyy', content: 'X' } }],
      '/ws/main.jhyy',
      initial,
    )
    expect(versions).toEqual([initial])
  })

  it('Read / Bash 不算改文件', () => {
    const versions = reconstructVersions(
      [{ name: 'Read', input: { file_path: '/ws/main.jhyy' } }],
      '/ws/main.jhyy',
      initial,
    )
    expect(versions).toEqual([initial])
  })
})

describe('parseStream', () => {
  it('抽出助手文本与工具调用', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先看看。' },
            { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a.jhyy', content: 'X' } },
          ],
        },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '改好了。' }] } }),
    ]
    const traj = parseStream(lines)
    expect(traj.answer).toBe('我先看看。改好了。')
    expect(traj.toolUses).toHaveLength(1)
    expect(traj.toolUses[0].name).toBe('Write')
  })

  it('半行 JSON / 噪声行不炸', () => {
    const traj = parseStream(['{不是 json', '', '{"type":"assistant"'])
    expect(traj.answer).toBe('')
    expect(traj.toolUses).toEqual([])
  })
})

describe('extractCodeFromAnswer', () => {
  it('抠出 ```jhyy 围栏里的代码', () => {
    const answer = '修好了：\n\n```jhyy\nfn main_jhyy() -> i32 {\n    return 1;\n}\n```\n'
    expect(extractCodeFromAnswer(answer)).toContain('main_jhyy')
  })

  it('没有围栏 ⇒ undefined', () => {
    expect(extractCodeFromAnswer('就是一句话')).toBeUndefined()
  })
})

describe('usedCompiler', () => {
  it('调了编译器 ⇒ true', () => {
    expect(
      usedCompiler([{ name: 'Bash', input: { command: 'jhyy.exe compile main.jhyy' } }]),
    ).toBe(true)
  })

  it('只是 ls ⇒ false', () => {
    expect(usedCompiler([{ name: 'Bash', input: { command: 'ls -la' } }])).toBe(false)
  })

  it('没调工具 ⇒ false', () => {
    expect(usedCompiler([])).toBe(false)
  })
})
