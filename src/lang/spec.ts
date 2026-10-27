import specIndex from './generated/spec-index.json'

/**
 * 语言规范索引 —— 悬停提示要能给出「§ 10.4 struct 按值传递」这样的章节引用，
 * 让用户不用离开 IDE 就能查规范。
 *
 * 索引由 `scripts/gen-spec-index.mjs` 从语言仓库的
 * `docs/abis/jhyy-lang-spec-v4.0.0.md` 生成（提交进仓库，打包时一起带上）。
 */

export interface SpecSection {
  /** 章节号，如 "10.4"、"附录 A" */
  num: string
  title: string
  /** 2 = ##, 3 = ###, 4 = #### */
  level: number
  body: string
}

export interface SpecMatch {
  section: SpecSection
  score: number
  /** 正文里命中位置前后的一小段 */
  excerpt: string
}

const SECTIONS = specIndex.sections as SpecSection[]
export const SPEC_VERSION = specIndex.version as string

function excerptAround(body: string, needle: string): string {
  const idx = body.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return body.slice(0, 160)
  const start = Math.max(0, idx - 60)
  const end = Math.min(body.length, idx + needle.length + 100)
  return (start > 0 ? '…' : '') + body.slice(start, end).trim() + (end < body.length ? '…' : '')
}

/**
 * 搜规范。
 *
 * 跟语言仓库的 `jhyy_spec_doc.py` 一样用 **token-AND** 打分：查询按空白切词，
 * 命中的词越多分越高。标题命中的额外加权 —— 标题命中说明这节讲的就是它。
 */
export function searchSpec(query: string, limit = 5): SpecMatch[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return []

  const matches: SpecMatch[] = []
  for (const section of SECTIONS) {
    const title = section.title.toLowerCase()
    const body = section.body.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (title.includes(token)) score += 3
      else if (body.includes(token)) score += 1
    }
    if (score === 0) continue
    matches.push({
      section,
      score,
      excerpt: excerptAround(section.body, tokens[0]),
    })
  }

  matches.sort((a, b) => b.score - a.score || a.section.level - b.section.level)
  return matches.slice(0, limit)
}

/** 单词 → 最贴切的那一节（悬停提示用）。 */
export function findSpecForWord(word: string): SpecMatch | null {
  const matches = searchSpec(word, 1)
  return matches[0] ?? null
}

/** 章节的引用形式，如 "§ 10.4 struct 按值传递"。 */
export function formatSectionRef(section: SpecSection): string {
  return section.num ? `§ ${section.num} ${section.title}` : section.title
}
