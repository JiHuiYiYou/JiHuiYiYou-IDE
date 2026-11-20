/**
 * 「常驻知识」的**查找路径**单测 —— 知识包 / 报错→修法表。
 *
 * ## 它守什么
 *
 * **打进安装包的那份**（`extraResources` ⇒ `<app>/resources/`）能被找到。
 *
 * ⚠️ **为什么必须有这条**（2026-11-20 收尾时发现）：
 *   知识包是 **IDE 聊天功能的常驻知识**（比手写的 12 行速查表多得多），
 *   但它**长在语言仓**、IDE **跨仓读** ⇒ ⇒ **用户机器上通常没有语言仓**
 *   ⇒ ⇒ 读不到 ⇒ ⇒ **退回 12 行速查表** ⇒ ⇒ 前面所有提示词工作
 *   **对终端用户等于零**（而**没人会发现** —— IDE 照常启动、照常有聊天）。
 *
 * ⇒ ⇒ 打包时必须把知识包**拷进安装包**（`scripts/dev/sync-knowledge-pack.py`）
 * ⇒ ⇒ 运行时必须能从 `process.resourcesPath` 找到它。
 *
 * ## 顺带守的
 *
 * 开发态**优先**用语言仓那份（刚生成的那份最新）⇒ 不是先命中谁用谁。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { errorFixPath, knowledgePackPath } from '../../src/main/claude/jhyy-rules'

/** `process.resourcesPath` 是 **Electron 专有**属性 ⇒ 用一个松类型操作它。 */
type Proc = { resourcesPath?: string }
function resProc(): Proc {
  return process as unknown as Proc
}

/** 临时把 `process.resourcesPath` 指到一个目录（Electron 专有属性）。 */
function withResourcesPath(dir: string | undefined, fn: () => void): void {
  const p = resProc()
  const saved = p.resourcesPath
  p.resourcesPath = dir
  try {
    fn()
  } finally {
    p.resourcesPath = saved
  }
}

describe('常驻知识的查找路径', () => {
  afterEach(() => {
    resProc().resourcesPath = undefined
  })

  it('打进安装包的知识包能被找到（用户机器上没有语言仓的那种情形）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-pack-'))
    const file = join(dir, 'jhyy-knowledge.md')
    writeFileSync(file, '# 知识包\n', 'utf8')
    withResourcesPath(dir, () => {
      expect(knowledgePackPath()).toBe(file)
    })
  })

  it('打进安装包的「报错 → 修法」表能被找到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-fix-'))
    const file = join(dir, 'jhyy-error-fix.json')
    writeFileSync(file, '{"entries":[]}\n', 'utf8')
    withResourcesPath(dir, () => {
      expect(errorFixPath()).toBe(file)
    })
  })

  it('没有 resourcesPath 时（普通 Node / 评测 harness）不乱指 —— 退回语言仓那份', () => {
    withResourcesPath(undefined, () => {
      const p = knowledgePackPath()
      if (p !== null) {
        // 找到了语言仓那份 ⇒ 路径里必须带 `docs/generated/jhyy-knowledge.md`
        expect(p.replace(/\\/g, '/')).toContain('docs/generated/jhyy-knowledge.md')
      } else {
        // 语言仓不在（CI 的别的 job）⇒ 返回 null 也对
        expect(p).toBeNull()
      }
    })
  })
})
