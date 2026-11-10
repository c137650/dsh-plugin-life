/**
 * 把仓库的分支压成一个干净的提交。
 *
 * 为什么要这一步:contents API(PUT /contents/{path})是**一个文件一个 commit**,
 * 用它初始化仓库会留下十几次没意义的提交,每个的说明还都带个 "(文件名)" 后缀。
 *
 * 现在仓库已经有 ref 了,Git Data API 能用了(空仓库不让建 blob,那是之前
 * publish_new_repo.mjs 走 contents API 的原因)。
 * 于是可以正经地:建 blob -> 建 tree(不带 base_tree)-> 建 commit(不带 parents)-> 挪 ref。
 * 原来的零碎提交变成不可达,历史里只剩一个。
 *
 * 用法: node tools/squash_repo.mjs <owner/repo> <本地目录> <branch> <message>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const [repo, dir, branch = 'main', message = 'init'] = process.argv.slice(2)
if (!repo || !dir) {
  console.error('用法: node tools/squash_repo.mjs <owner/repo> <本地目录> [branch] [message]')
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
console.log('文件:', files.length)

const tree = []
for (const f of files) {
  const content = readFileSync(path.join(dir, f))
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha })
  console.log('  ', f)
}

// 不带 base_tree —— 从零建一棵,原来的提交就不可达了
const newTree = await api('POST', `/repos/${repo}/git/trees`, { tree })
const newCommit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [],
})
// 新的根提交不是当前 ref 的后代,所以要 force。
// 不加 force 会回 422 "Update is not a fast forward" —— ref 不能往回挪。
await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha, force: true })

console.log('\n压成一个提交:', newCommit.sha.slice(0, 8))
console.log('https://github.com/' + repo + '/commit/' + newCommit.sha)

const list = await api('GET', `/repos/${repo}/commits?sha=${branch}&per_page=100`)
console.log('这个分支上的提交数:', Array.isArray(list) ? list.length : '?')
