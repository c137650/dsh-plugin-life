/**
 * 用 GitHub 的 Git Data API 推一次提交。
 *
 * 为什么要这样:本机现在连不上 github.com:443(git push 走的就是它),
 * 但 api.github.com 通。所以用 API 代替 git 协议:
 *   建 blob -> 建 tree -> 建 commit -> 挪 ref
 * 效果和 git push 完全一样,只是多几个往返。
 *
 * 用法: node push_via_api.mjs <repo> <branch> <message>
 * 凭据从 git credential fill 里拿,不落盘、不打印。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const [repo, branch, message] = process.argv.slice(2)
if (!repo || !branch || !message) {
  console.error('用法: node push_via_api.mjs <owner/repo> <branch> <message>')
  process.exit(2)
}

// ---- 拿 token ----
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
  'User-Agent': 'dsh-plugin-life',
  Accept: 'application/vnd.github+json',
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

// ---- 本地有哪些改动(相对远端) ----
//
// 注意重命名:git 输出的是 "R072<TAB>旧路径<TAB>新路径",
// 不是简单的"一个状态 + 一个路径"。当成"删旧的 + 建新的"处理。
const diff = []
for (const line of execSync('git diff --name-status origin/main HEAD', { encoding: 'utf8' }).split('\n')) {
  const l = line.trim()
  if (!l) continue
  const parts = l.split('\t')
  const code = parts[0][0]
  if (code === 'R') {
    diff.push({ code: 'D', file: parts[1] })
    diff.push({ code: 'A', file: parts[2] })
  } else if (code === 'C') {
    diff.push({ code: 'A', file: parts[2] })
  } else {
    diff.push({ code, file: parts[1] })
  }
}

console.log('待推改动', diff.length, '个')

// ---- 基线 ----
const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
const baseSha = ref.object.sha
const baseCommit = await api('GET', `/repos/${repo}/git/commits/${baseSha}`)
console.log('基线 commit', baseSha.slice(0, 8), String(baseCommit.message).split('\n')[0])

// ---- 逐个建 blob / 删条目 ----
const tree = []
for (const { code, file } of diff) {
  if (code === 'D') {
    tree.push({ path: file, mode: '100644', type: 'blob', sha: null })
    console.log('  删除', file)
    continue
  }
  if (!existsSync(file)) {
    console.log('  跳过(文件不在)', file)
    continue
  }
  const content = readFileSync(file)
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
  console.log('  写入', file, (content.length / 1024).toFixed(1) + 'K')
}

// ---- 建 tree / commit / 挪 ref ----
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

console.log('推上去了:', newCommit.sha.slice(0, 8))
console.log('https://github.com/' + repo + '/commit/' + newCommit.sha)
