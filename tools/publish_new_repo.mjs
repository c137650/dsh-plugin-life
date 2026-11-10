/**
 * 把一个本地目录推成一个**全新的** GitHub 仓库。
 *
 * 为什么不用 git push:本机经常连不上 github.com:443(git 协议走的就是它),
 * 但 api.github.com 通。所以走 Git Data API:
 *   建 blob -> 建 tree -> 建 commit -> 建 ref
 * 效果和 git push 一样,只是多几个往返。
 *
 * 和 push_via_api.mjs 的区别:那个假设远端已经有分支(要拿基线 commit),
 * 新仓库没有基线,所以这里没有 base_tree、没有 parents,最后是"建 ref"而不是"挪 ref"。
 *
 * 用法: node tools/publish_new_repo.mjs <owner/repo> <本地目录> <branch> <message>
 * 凭据从 git credential fill 里拿,不落盘、不打印。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const [repo, dir, branch = 'main', message = 'init'] = process.argv.slice(2)
if (!repo || !dir) {
  console.error('用法: node tools/publish_new_repo.mjs <owner/repo> <本地目录> [branch] [message]')
  process.exit(2)
}

const token = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice('password='.length)
if (!token) {
  console.error('拿不到 GitHub 凭据')
  process.exit(2)
}

const API = 'https://api.github.com'
const headers = {
  Authorization: `token ${token}`,
  'User-Agent': 'dsh-plugin-publisher',
  Accept: 'application/vnd.github+json',
}

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

/** 收集要推的文件(跳过 .git 和 .gitignore 里列的)。 */
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])
function collect(root, base = '') {
  const out = []
  for (const name of readdirSync(path.join(root, base))) {
    if (SKIP.has(name)) continue
    const rel = base ? path.join(base, name) : name
    const full = path.join(root, rel)
    if (statSync(full).isDirectory()) out.push(...collect(root, rel))
    else out.push(rel.split(path.sep).join('/'))
  }
  return out
}

const files = collect(dir)
console.log('要推的文件:', files.length)

// ---- 空仓库还是已有内容? ----
//
// 空仓库不能走 Git Data API:POST /git/blobs 会回 409 "Git Repository is empty."
// (GitHub 不允许在一个还没有任何 ref 的仓库里建 blob)。
//
// 空仓库要用 contents API(PUT /repos/{owner}/{repo}/contents/{path}):
// 它能在空仓库上工作,而且第一个 PUT 顺手把分支建出来。
let empty = false
try {
  await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
} catch {
  empty = true
}
console.log(empty ? '远端是空仓库,走 contents API' : '远端已有内容,走 Git Data API')

if (empty) {
  for (const f of files) {
    const content = readFileSync(path.join(dir, f)).toString('base64')
    await api('PUT', `/repos/${repo}/contents/${f}`, {
      message: message + (files.length > 1 ? ` (${f})` : ''),
      content,
      branch,
    })
    console.log('  ', f)
  }
  const r = await api('GET', `/repos/${repo}/commits/${branch}`)
  console.log('推上去了:', r.sha.slice(0, 8))
  console.log('https://github.com/' + repo + '/commit/' + r.sha)
  process.exit(0)
}

const tree = []
for (const f of files) {
  const content = readFileSync(path.join(dir, f))
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha })
  console.log('  ', f, (content.length / 1024).toFixed(1) + 'K')
}

const newTree = await api('POST', `/repos/${repo}/git/trees`, { tree })
const newCommit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [],
})

// 远端可能已经有同名 ref(重跑一次),有就挪,没有就建。
try {
  await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha })
  console.log('挪了已有的 ref')
} catch {
  await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: newCommit.sha })
  console.log('建了新 ref')
}

console.log('推上去了:', newCommit.sha.slice(0, 8))
console.log('https://github.com/' + repo + '/commit/' + newCommit.sha)
