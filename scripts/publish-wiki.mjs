#!/usr/bin/env node
/**
 * publish-wiki —— 把 `docs/wiki/*.md` 推到 GitHub 的 wiki 仓库。
 *
 * **为什么 wiki 内容放在仓库里而不是只放在 wiki 里**：wiki 页面也该被 review。
 * 页面正文进版本控制 ⇒ 改动能进 PR、能 diff、能回滚；发布只是把它推上去。
 *
 * ## 用法
 *
 * ```bash
 * npm run publish:wiki
 * ```
 *
 * ## 前提：GitHub 只从**网页**创建 wiki 仓库
 *
 * wiki 的 git 仓库（`<owner>/<repo>.wiki.git`）是 GitHub 在你**第一次从网页新建
 * 页面**时才创建的。之后就能推了 —— 但在那之前：
 *
 *   · `git push` ⇒ `Repository not found`
 *   · REST API（`PUT /repos/{owner}/{repo}.wiki/contents/…`）⇒ 404
 *   · GraphQL ⇒ 根本没有 wiki 的字段
 *
 * 所以**第一次**要手动做一下：
 *
 *   1. 打开 <https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/wiki>
 *   2. 点 "Create the first page"，随便写个标题，保存
 *   3. 回来跑 `npm run publish:wiki` —— 本脚本会**覆盖**那个占位页面
 *
 * 本脚本自己**不会**去建 wiki 仓库（做不到），但会把上面这段话打印出来。
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = join(root, 'docs', 'wiki')

/**
 * 从 git remote 推出 wiki 的 URL：git@github.com:OWNER/REPO.git → …/REPO.wiki.git
 *
 * ⚠️ **ssh 形式必须连 `git@` 一起带上。**
 * 早先写成 `${host}:${path}.wiki.git` —— 少了 `git@`，git 会把 `github.com:`
 * 当成「主机 + 路径」而不是 scp 式的「用户@主机:路径」⇒ 连都连不上。
 */
function wikiUrl() {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  const https = remote.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (https) return `https://github.com/${https[1]}/${https[2]}.wiki.git`

  const ssh = remote.match(/^([^@]+)@([^:]+):(.+?)(?:\.git)?$/)
  if (ssh) return `${ssh[1]}@${ssh[2]}:${ssh[3]}.wiki.git`

  throw new Error(`看不出 remote 是什么形式：${remote}`)
}

/**
 * 本仓库 local config 里的 `core.sshCommand`（指定用哪把私钥）。
 *
 * **必须显式带到 clone/push 上**：wiki 仓库 clone 到**临时目录**，
 * 那里没有本仓库的 local config ⇒ SSH 认证会失败
 * （`~/.ssh` 在 MSYS2 下是空的，见 git-push.md）。
 */
function sshCommand() {
  try {
    const v = execFileSync('git', ['config', '--local', '--get', 'core.sshCommand'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    return v || null
  } catch {
    return null
  }
}

/** 把 `-c core.sshCommand=…` 塞到 git 参数前面（如果有的话）。 */
function withSsh(args) {
  const cmd = sshCommand()
  return cmd ? ['-c', `core.sshCommand=${cmd}`, ...args] : args
}

function git(args, cwd, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', ...opts })
}

function fail(msg) {
  console.error(`\n[publish-wiki] ${msg}\n`)
  process.exit(1)
}

if (!existsSync(sourceDir)) {
  fail(`找不到 ${sourceDir}`)
}

const pages = readdirSync(sourceDir).filter((f) => f.endsWith('.md'))
if (pages.length === 0) {
  fail(`${sourceDir} 里没有 .md 页面`)
}

const url = wikiUrl()
const work = mkdtempSync(join(tmpdir(), 'jhyy-wiki-'))

console.log(`[publish-wiki] 源目录：${sourceDir}`)
console.log(`[publish-wiki] 页面数：${pages.length}（${pages.join(', ')}）`)
console.log(`[publish-wiki] 目标：${url}`)

try {
  git(withSsh(['clone', '--depth', '1', url, work]), root)
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  if (/Repository not found|Could not read from remote/i.test(out)) {
    fail(
      [
        'GitHub 上还没有这个 wiki 仓库 —— 它只能从**网页**创建（API / git 都不行）。',
        '',
        '  1. 打开 https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/wiki',
        '  2. 点 "Create the first page"，随便写个标题，保存',
        '  3. 回来再跑一次 npm run publish:wiki（本脚本会覆盖那个占位页）',
      ].join('\n'),
    )
  }
  fail(`clone 失败：\n${out}`)
}

/**
 * 页面标题表 —— 侧栏里显示的名字（不是文件名）。
 *
 * GitHub 的 wiki 拿**文件名**当页面标题：`Architecture.zh-CN.md` ⇒ 标题
 * "Architecture.zh CN"，侧栏里就一堆这种 ugly 的条目（它不认 linguist 那套
 * locale 变体分组）。⇒ 自己生成 `_Sidebar.md`（GitHub wiki 的侧栏约定），
 * 把两套语言分开列，名字用这里的中英文标题。
 */
const WIKI_TITLES = {
  Home: ['Home', '首页'],
  'Getting-Started': ['Getting Started', '快速上手'],
  Architecture: ['Architecture', '架构'],
  'Block-Subset': ['Block Subset', '块子集'],
  'Claude-Code': ['Claude Code', 'Claude Code'],
  Troubleshooting: ['Troubleshooting', '疑难排查'],
  Contributing: ['Contributing', '贡献指南'],
}

/**
 * 生成 `_Sidebar.md`。
 *
 * **从文件列表生成，不手写** —— 手写的侧栏会漏（加了页面忘了更新）。
 */
function buildSidebar(pages) {
  const base = pages.filter((p) => !p.endsWith('.zh-CN.md')).map((p) => p.replace(/\.md$/, ''))
  const zh = pages.filter((p) => p.endsWith('.zh-CN.md')).map((p) => p.replace(/\.zh-CN\.md$/, ''))

  // 顺序按 WIKI_TITLES 的声明顺序（Home → 快速上手 → 架构 …），不是字母序。
  // 表里没有的页面（新增的）按文件名排在后面 —— 不能悄悄丢掉。
  const known = Object.keys(WIKI_TITLES)
  const order = (list) => [
    ...known.filter((k) => list.includes(k)),
    ...list.filter((k) => !known.includes(k)).sort(),
  ]

  const line = (names, idx) =>
    order(names)
      .map((n) => {
        const t = WIKI_TITLES[n]
        const label = t ? t[idx] : n
        return `[${label}](${n}${idx === 1 ? '.zh-CN' : ''})`
      })
      .join(' · ')

  return [
    '## JHYY IDE',
    '',
    line(base, 0),
    '',
    '## 中文',
    '',
    line(zh, 1),
    '',
    '---',
    '',
    '[仓库](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE) · ' +
      '[Releases](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/releases) · ' +
      '[问题](https://github.com/JiHuiYiYou/JiHuiYiYou-IDE/issues) · ' +
      '[编译器仓库](https://github.com/JiHuiYiYou/JiHuiYiYou-compiler)',
    '',
  ].join('\n')
}

try {
  // 只清 .md —— wiki 仓库里可能有别的文件（比如 .github 之类），别误删。
  for (const entry of readdirSync(work)) {
    if (entry.endsWith('.md')) rmSync(join(work, entry), { force: true })
  }
  cpSync(sourceDir, work, { recursive: true, force: true })

  // 侧栏是**生成**的 —— 不在 docs/wiki/ 里，免得它被当成一个页面发布出去。
  writeFileSync(join(work, '_Sidebar.md'), buildSidebar(pages), 'utf8')

  git(['add', '--all'], work)
  const status = git(['status', '--porcelain'], work).trim()
  if (!status) {
    console.log('[publish-wiki] wiki 已经是最新 —— 没有东西要发布。')
    process.exit(0)
  }

  git(['-c', 'user.name=JHYY', '-c', 'user.email=15901598712@163.com', 'commit', '-m',
    'docs(wiki): 从 docs/wiki/ 同步',], work)
  git(withSsh(['push', 'origin', 'HEAD']), work)
  console.log('[publish-wiki] ✅ 已发布。')
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  fail(`发布失败：\n${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
