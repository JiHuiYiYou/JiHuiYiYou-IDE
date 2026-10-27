#!/usr/bin/env node
/**
 * 从语言仓库的规范 markdown 生成 `src/lang/generated/spec-index.json`。
 *
 * 用途：IDE 的悬停提示要能给出「§ 10.4 struct 按值传递」这样的章节引用 ——
 * 让用户不用离开 IDE 就能查规范。
 *
 * 分节规则跟语言仓库的 `mcp-jhyy/jhyy_spec_doc.py` 一致（h2/h3/h4 都是节边界，
 * 章节号支持到三级）。
 *
 *     node scripts/gen-spec-index.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ideRoot = resolve(here, '..')

/** 找语言仓库里的规范文件。 */
function findSpec() {
  const candidates = [
    resolve(ideRoot, '..', 'JiHuiYiYou', 'docs', 'abis', 'jhyy-lang-spec-v4.0.0.md'),
    resolve(ideRoot, '..', 'JiHuiYiYou', 'docs', 'abis'),
  ]
  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith('abis')) return c
  }
  // 退而求其次：扫 abis 目录里版本号最高的 lang-spec
  const dir = candidates[1]
  if (existsSync(dir)) {
    const specs = readdirSync(dir)
      .filter((f) => /^jhyy-lang-spec-v.*\.md$/.test(f))
      .sort()
      .reverse()
    if (specs[0]) return join(dir, specs[0])
  }
  return null
}

const HEADING_RE = /^(#{2,4})\s+(.+?)\s*$/
const NUM_PREFIX_RE =
  /^(?:(\d+(?:\.\d+){0,2})\.?|附录\s+([A-Z])[：:]|v(\d+\.\d+\.\d+))[\s:：]*(.+)$/

function parseSections(text) {
  const sections = []
  let current = null
  let body = []

  const flush = () => {
    if (!current) return
    current.body = body.join('\n').trim()
    sections.push(current)
    current = null
    body = []
  }

  for (const line of text.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line)
    if (!m) {
      if (current) body.push(line)
      continue
    }
    flush()
    const level = m[1].length
    let num = ''
    let title = m[2].trim()
    const numMatch = NUM_PREFIX_RE.exec(title)
    if (numMatch) {
      num = numMatch[1] ?? (numMatch[2] ? `附录 ${numMatch[2]}` : (numMatch[3] ?? ''))
      title = numMatch[4].trim()
    }
    current = { num, title, level }
  }
  flush()
  return sections
}

const specPath = findSpec()
if (!specPath) {
  console.error('✗ 找不到语言仓库的规范文件（../JiHuiYiYou/docs/abis/jhyy-lang-spec-v*.md）')
  process.exit(1)
}

const text = readFileSync(specPath, 'utf-8')
const sections = parseSections(text)
const version = /jhyy-lang-spec-v(\d+\.\d+\.\d+)/.exec(specPath)?.[1] ?? '4.0.0'

const out = {
  version,
  source: specPath.replace(/\\/g, '/'),
  sections: sections.map((s) => ({
    num: s.num,
    title: s.title,
    level: s.level,
    body: s.body.slice(0, 4000),
  })),
}

const target = join(ideRoot, 'src', 'lang', 'generated', 'spec-index.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(out), 'utf8')

console.log(`✓ ${specPath}`)
console.log(`  → ${target}`)
console.log(`  ${sections.length} 个章节，版本 ${version}`)
