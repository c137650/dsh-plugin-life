/**
 * 建一个 GitHub 仓库。
 *
 * 用 API 而不是网页:凭据从 git credential fill 里拿,不落盘、不打印。
 *
 * 用法: node tools/create_repo.mjs <owner/repo> [public|private] ["说明"]
 */
import { execFileSync } from 'node:child_process'

const [repo, visibility = 'public', description = ''] = process.argv.slice(2)
if (!repo) {
  console.error('用法: node tools/create_repo.mjs <owner/repo> [public|private] ["说明"]')
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

// 建仓库的端点是 POST /user/repos ——
// POST /repos/{owner}/{repo} 是"改仓库"(PATCH 的兄弟),对不存在的仓库会回 404。
const res = await fetch('https://api.github.com/user/repos', {
  method: 'POST',
  headers: {
    Authorization: `token ${token}`,
    'User-Agent': 'dsh-plugin-publisher',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: repo.split('/')[1],
    description,
    private: visibility === 'private',
    auto_init: false,
  }),
})

const text = await res.text()
if (!res.ok) {
  // 422 = 已经存在
  console.error('创建失败:', res.status, text.slice(0, 300))
  process.exit(1)
}
const j = JSON.parse(text)
console.log('建好了:', j.html_url)
console.log('可见性:', j.private ? 'private' : 'public')
