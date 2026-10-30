import { createElement, type ReactNode } from 'react'

/**
 * 极简 Markdown 渲染（**只渲染成 React 元素，不碰 innerHTML**）。
 *
 * ⚠️ **为什么不引第三方库**：
 * - 常见的 `marked` / `react-markdown` 都要往 DOM 里塞 HTML —— 而 AI 的输出
 *   是**不可信内容**（它可能把读到的文件内容原样吐出来）⇒ `innerHTML` 就是
 *   XSS 口子。这里全程用 React 元素 ⇒ 天生没有这个问题。
 * - 少一个依赖 ⇒ 少一份供应链风险。
 *
 * 支持的语法（够 Claude Code 的输出用了）：
 * - `### 标题`
 * - ``` 代码块 ```
 * - `行内代码`
 * - **粗体** / *斜体* / ~~删除线~~
 * - `- 列表` / `1. 有序列表`
 * - `> 引用`
 * - [链接](url)
 * - 段落之间空一行
 */
export function Markdown({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text)
  return createElement('div', { className: 'md' }, blocks.map((b, i) => renderBlock(b, i)))
}

// ── 解析 ────────────────────────────────────────────────────────

type Block =
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'hr' }

/** 把文本切成「块」。 */
function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // 跳过结束的 ```
      blocks.push({ kind: 'code', lang, lines: body })
      continue
    }

    // 空行
    if (!line.trim()) {
      i++
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim() })
      i++
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }

    // 列表
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        i++
        // 续行（缩进的下一行）算同一项
        while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          item += ' ' + lines[i].trim()
          i++
        }
        items.push(item)
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // 段落（连续的非空行）
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push({ kind: 'para', text: para.join('\n') })
  }

  return blocks
}

// ── 渲染 ────────────────────────────────────────────────────────

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'code':
      return createElement(
        'pre',
        { className: 'md-code', key, 'data-lang': block.lang || undefined },
        createElement('code', null, block.lines.join('\n')),
      )
    case 'heading': {
      const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2'
      return createElement(Tag, { className: 'md-heading', key }, inline(block.text))
    }
    case 'list':
      return createElement(
        block.ordered ? 'ol' : 'ul',
        { className: 'md-list', key },
        block.items.map((item, i) => createElement('li', { key: i }, inline(item))),
      )
    case 'quote':
      return createElement('blockquote', { className: 'md-quote', key }, inline(block.text))
    case 'hr':
      return createElement('hr', { className: 'md-hr', key })
    case 'para':
      return createElement('p', { className: 'md-para', key }, inline(block.text))
  }
}

/** 行内语法：`代码` / **粗体** / *斜体* / ~~删除线~~ / [链接](url)。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  // 一次匹配一种（代码优先，免得代码里的 * 被当粗体）
  const re =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(createElement('code', { className: 'md-inline-code', key: key++ }, tok.slice(1, -1)))
    } else if (tok.startsWith('**')) {
      out.push(createElement('strong', { key: key++ }, tok.slice(2, -2)))
    } else if (tok.startsWith('~~')) {
      out.push(createElement('del', { key: key++ }, tok.slice(2, -2)))
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
      out.push(
        createElement(
          'a',
          { key: key++, href: mm?.[2], target: '_blank', rel: 'noreferrer' },
          mm?.[1] ?? tok,
        ),
      )
    } else {
      out.push(createElement('em', { key: key++ }, tok.slice(1, -1)))
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
