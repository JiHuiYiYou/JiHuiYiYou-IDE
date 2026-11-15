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
  classifyTool,
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

/**
 * **越界探索**的归类 —— 2026-11-15 加。
 *
 * 为什么要有这一类：实测三臂 24 道题的轨迹里，**每一道翻了判分脚本的题，
 * 它的第 1 版就已经通过了** ⇒ 模型不知道自己过了 ⇒ 去翻判分脚本找答案
 * （最后还抄了 difftest 的参考实现）⇒ 白烧 5~9 次调用。
 *
 * ⇒ 这一类必须能**看见**这两件事，否则归因会把它们记成「探索」，
 *   于是「该补 stdlib 用法」的结论就下错了。
 */
describe('classifyTool —— 越界探索', () => {
  it('翻判分脚本 ⇒ peek-grader（不是 explore / 不是 run）', () => {
    expect(
      classifyTool('Bash', 'cat bench/difftest.py | tail -20'),
    ).toBe('peek-grader')
    expect(
      classifyTool('Bash', 'head -c 600 bench/seeds/golden.json'),
    ).toBe('peek-grader')
    expect(
      classifyTool('Read', 'C:/repo/JiHuiYiYou/bench/difftest.py'),
    ).toBe('peek-grader')
  })

  it('翻编译器实现源码 ⇒ peek-impl', () => {
    expect(
      classifyTool('Bash', 'grep -n "fputs_stdout|setmode" compiler/src0/jhyy_helpers.c'),
    ).toBe('peek-impl')
    expect(
      classifyTool('Read', 'C:/repo/JiHuiYiYou/compiler/src0/sema.jhyy'),
    ).toBe('peek-impl')
    // ⚠️ Windows 的**反斜杠**路径也要认出来（模型给 Read 的 file_path 常是反斜杠）
    expect(
      classifyTool('Read', 'C:\\repo\\JiHuiYiYou\\compiler\\src0\\sema.jhyy'),
    ).toBe('peek-impl')
  })

  it('⚠️ 普通的探索/读文件**不能**被误判成越界', () => {
    expect(classifyTool('Bash', 'ls -la')).toBe('explore')
    expect(classifyTool('Bash', 'find . -name "*.jhyy"')).toBe('explore')
    expect(classifyTool('Read', 'C:\tmp\jhyy-eval-abc\main.c')).toBe('read')
    expect(classifyTool('Bash', 'cat main.c')).toBe('run')
  })

  it('⚠️ 越界判据**优先于**常规归类（一条 grep 判分脚本的命令先判 peek）', () => {
    // 这条命令本来会被 `grep` 规则归成 'explore'
    expect(classifyTool('Bash', 'grep -rn "difftest" --include=*.py .')).toBe('peek-grader')
  })
})
