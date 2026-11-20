#!/usr/bin/env node
/**
 * 把**知识包**从语言仓拷进 IDE 的**打包资源目录**。
 *
 *     node scripts/dev/sync-knowledge-pack.mjs
 *
 * ## 为什么要有（2026-11-20 收尾时发现）
 *
 * 知识包（`docs/generated/jhyy-knowledge.md`）是 **IDE 聊天功能的常驻知识** ——
 * 它比手写的 12 行速查表多得多（全部反直觉规则 + C 迁移表 + 台账 ACTIVE 缺陷
 * + 附录 B「未实装」清单 + 标准库签名 + 能编译的用法）。
 *
 * ⚠️ **但它长在语言仓，而 IDE 是跨仓读它的** ⇒ ⇒ **装了 IDE 的机器上
 * 通常没有语言仓** ⇒ ⇒ `knowledgePackPath()` 读不到 ⇒ ⇒ **退回 12 行速查表**
 * ⇒ ⇒ **前面所有提示词工作，对终端用户等于零**（而**没人会发现** ——
 * IDE 照常启动、照常有聊天，只是模型不知道那些坑）。
 *
 * ⇒ ⇒ 打包前把它**拷进安装包**（`extraResources`）⇒ ⇒ 用户机器上就有。
 *
 * ## 为什么「拷贝」而不是「在 IDE 仓里存一份」
 *
 * - 真相在**语言仓**（规范 + 标准库源码）⇒ IDE 仓存一份 ⇒ **会有第二份真相**
 *   ⇒ ⇒ 漂。
 * - 拷贝发生在**打包那一刻** ⇒ ⇒ 进仓的永远是「跟这次发布配套的那份」。
 * - 拷贝源跟评测 harness 读的是**同一个文件** ⇒ ⇒ 评测测的 = 用户拿到的。
 *
 * ## 为什么**找不到语言仓就报错**（不静默跳过）
 *
 * 仓内一条硬约束（跟回归门、跟语料锁一样）：**门不许静默跳过** ⇒ ⇒
 * 静默跳过 = 打包出一个「只有 12 行速查表」的 IDE ⇒ ⇒ 而**没人会发现**
 * ⇒ ⇒ 效率提升悄悄归零。
 *
 * ## 为什么是 **node** 而不是 python
 *
 * 打包路径（`npm run dist`）**不依赖 python** ⇒ ⇒ CI 的 release job
 * 不用装 python、也不用管「`python` 还是 `py`」⇒ ⇒ 少一个能红的地方。
 * （评测的生成器仍然用 python —— 那是另一条路径。）
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const IDE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_DIR = join(IDE_ROOT, 'build-resources')

/** (语言仓里的相对路径, 拷进安装包后的名字) */
const FILES = [
  ['docs/generated/jhyy-knowledge.md', 'jhyy-knowledge.md'],
  ['docs/generated/jhyy-error-fix.json', 'jhyy-error-fix.json'],
]

/**
 * 这个目录**像**语言仓吗？（看有没有语料，不看名字 ⇒ 名字变了也不怕）
 * ⚠️ 跟 `scripts/dev/refresh-artifacts.py` 的 `_looks_like_lang_repo` 同口径。
 */
function looksLikeLangRepo(dir) {
  return (
    existsSync(join(dir, 'bench', 'difftest.py')) ||
    existsSync(join(dir, 'compiler', 'src0', 'main.jhyy'))
  )
}

/** 语言仓在哪？（环境变量 → 兄弟目录 → 常见开发布局） */
function findLangRepo() {
  const candidates = []
  const env = process.env.JHY_LANG_REPO
  if (env) candidates.push(env)
  candidates.push(resolve(IDE_ROOT, '..', 'JiHuiYiYou'))
  candidates.push(resolve(process.cwd(), '..', 'JiHuiYiYou'))
  candidates.push(resolve(process.env.HOME ?? '', 'Desktop', 'coding', 'JiHuiYiYou'))
  for (const dir of candidates) {
    if (dir && looksLikeLangRepo(dir)) return dir
  }
  return null
}

function main() {
  const lang = findLangRepo()
  if (!lang) {
    console.error('✗ 找不到语言仓 ⇒ **拿不到知识包**')
    console.error('  ⇒ 知识包是 IDE 聊天功能的**常驻知识** ⇒ 不带它打包 ⇒')
    console.error('    装出来的 IDE 只有 12 行速查表 ⇒ 效率提升**归零**。')
    console.error('  ⇒ 修法：把语言仓 checkout 成兄弟目录（或设 `JHY_LANG_REPO`）再打包。')
    return 1
  }

  mkdirSync(OUT_DIR, { recursive: true })
  for (const [rel, name] of FILES) {
    const src = join(lang, rel)
    if (!existsSync(src)) {
      console.error(`✗ 语言仓里没有 \`${rel}\``)
      console.error('  ⇒ 先在语言仓跑 `python scripts/gen-knowledge.py` 生成它。')
      return 1
    }
    const dst = join(OUT_DIR, name)
    copyFileSync(src, dst)
    console.log(`[sync-knowledge-pack] ✓ ${src}  ⇒  ${dst}`)
  }
  return 0
}

process.exit(main())
