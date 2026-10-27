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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = join(root, 'docs', 'wiki')

/** 从 git remote 推出 wiki 的 URL：git@github.com:OWNER/REPO.git → …/REPO.wiki.git */
function wikiUrl() {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()

  const https = remote.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (https) return `https://github.com/${https[1]}/${https[2]}.wiki.git`

  const ssh = remote.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/)
  if (ssh) return `${ssh[1]}:${ssh[2]}.wiki.git`

  throw new Error(`看不出 remote 是什么形式：${remote}`)
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
  git(['clone', '--depth', '1', url, work], root)
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

try {
  // 只清 .md —— wiki 仓库里可能有别的文件（比如 .github 之类），别误删。
  for (const entry of readdirSync(work)) {
    if (entry.endsWith('.md')) rmSync(join(work, entry), { force: true })
  }
  cpSync(sourceDir, work, { recursive: true, force: true })

  git(['add', '--all'], work)
  const status = git(['status', '--porcelain'], work).trim()
  if (!status) {
    console.log('[publish-wiki] wiki 已经是最新 —— 没有东西要发布。')
    process.exit(0)
  }

  git(['-c', 'user.name=JHYY', '-c', 'user.email=15901598712@163.com', 'commit', '-m',
    'docs(wiki): 从 docs/wiki/ 同步',], work)
  git(['push', 'origin', 'HEAD'], work)
  console.log('[publish-wiki] ✅ 已发布。')
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  fail(`发布失败：\n${out}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
