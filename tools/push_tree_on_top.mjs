/**
 * 把本地目录的内容推到远端分支的**顶上**(加一个新提交,不重写历史)。
 *
 * 什么时候用这个:github.com:443 时通时不通,git fetch 常常连不上,
 * 于是本地拿不到 origin/main,没法做正常的 diff-then-push。
 * 但 api.github.com 一直是通的,所以直接走 API:
 *   建 blob -> 在远端那棵树的基础上建新 tree -> 建 commit(带父提交)-> 挪 ref
 *
 * 跟 squash_repo.mjs 的区别:那个是从零建树、force 挪 ref(压成一个提交);
 * 这个是**接在远端当前提交后面**,历史保留。
 *
 * 用法: node tools/push_tree_on_top.mjs <owner/repo> <本地目录> [branch] [message]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const [repo, dir, branch = 'main', message = 'update'] = process.argv.slice(2)
if (!repo || !dir) {
  console.error('用法: node tools/push_tree_on_top.mjs <owner/repo> <本地目录> [branch] [message]')
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

// ---- 远端现在的样子 ----
const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
const baseSha = ref.object.sha
const baseCommit = await api('GET', `/repos/${repo}/git/commits/${baseSha}`)
const baseTree = await api('GET', `/repos/${repo}/git/trees/${baseCommit.tree.sha}?recursive=1`)
const basePaths = new Map()
for (const e of baseTree.tree ?? []) if (e.type === 'blob') basePaths.set(e.path, e.sha)

console.log('远端基线:', baseSha.slice(0, 8), '| 文件', basePaths.size, '个')

const tree = []
const localPaths = new Set(files)
for (const f of files) {
  const content = readFileSync(path.join(dir, f))
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  if (basePaths.get(f) === blob.sha) {
    console.log('  =', f, '(没变)')
    continue
  }
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha })
  console.log('  ~', f, (content.length / 1024).toFixed(1) + 'K')
}
// 远端有、本地没有的 → 删掉
for (const p of basePaths.keys()) {
  if (!localPaths.has(p)) {
    tree.push({ path: p, mode: '100644', type: 'blob', sha: null })
    console.log('  -', p, '(本地没了)')
  }
}

if (!tree.length) {
  console.log('远端已经是最新的')
  process.exit(0)
}

const newTree = await api('POST', `/repos/${repo}/git/trees`, {
  base_tree: baseCommit.tree.sha,
  tree,
})
const newCommit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [baseSha],
})
await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha })
console.log('\n推上去了:', newCommit.sha.slice(0, 8))
console.log('https://github.com/' + repo + '/commit/' + newCommit.sha)
