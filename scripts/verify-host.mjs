/**
 * host 半区自检：不挂 profile，直接把 index.js 的 apply() 跑起来，用假的 ctx.subprocess 执行真实 git，
 * 校验只读端点的解析结果、错误码与写操作门禁。
 *
 * 用法：node scripts/verify-host.mjs [仓库路径]   （默认当前目录；只做只读调用，不改仓库状态）
 *
 * 注意：沙箱下 Node 抓子进程输出不能用管道（EPERM），这里统一用文件描述符重定向。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(process.argv[2] ?? process.cwd())
const scratch = mkdtempSync(join(tmpdir(), 'gitvcs-verify-'))
let counter = 0

const fakeSubprocess = {
  async resolveExecutable(command) {
    return command
  },
  spawn(spec) {
    const id = counter++
    const outPath = join(scratch, `out-${id}.txt`)
    const errPath = join(scratch, `err-${id}.txt`)
    const outFd = openSync(outPath, 'w')
    const errFd = openSync(errPath, 'w')
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      signal: spec.signal,
    })
    const done = new Promise((settle, reject) => {
      child.on('error', (cause) => {
        closeSync(outFd)
        closeSync(errFd)
        reject(cause)
      })
      child.on('close', (code, signal) => {
        closeSync(outFd)
        closeSync(errFd)
        settle({ exitCode: code, signal: signal ?? null })
      })
    })
    const reader = (path) => ({
      readFrom() {
        let text = ''
        try {
          text = readFileSync(path, 'utf8')
        } catch {
          text = ''
        }
        return { text, nextOffset: text.length, lossy: false }
      },
    })
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: reader(outPath), stderr: reader(errPath) },
      done,
      terminate() {
        child.kill()
      },
      async waitForExit() {
        return true
      },
    }
  },
}

/* host 半区现在自己往 webServer 注册 RPC 路由，并复用 connection.requestRejection 做信任栅栏；
   这里给两个垫片，并把「调用端点」包成走这条路由（信封与 Connection RPC 一致）。 */
function makeFakeWebServer(holder) {
  return {
    register(route) {
      holder.route = route
      return () => { holder.route = undefined }
    },
  }
}
const fakeConnection = { requestRejection: () => undefined }

/** 造一个只读的请求体迭代器 + 收集响应的假 res。 */
async function callRoute(holder, endpoint, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `verify-${endpoint}`, method: endpoint, payload })
  const response = holder.response
  await holder.route.handler({
    method: 'POST',
    url: `/git-vcs/${endpoint}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }, {
    writeHead(status) { response.status = status },
    end(value) { response.body = value === undefined ? '' : String(value) },
  })
  if (response.status !== 200) throw new Error(`HTTP ${response.status} ${response.body.slice(0, 80)}`)
  const full = JSON.parse(response.body)
  if (full.type !== 'server-response') throw new Error(`响应不是 server-response：${response.body.slice(0, 120)}`)
  return full.result
}

const mainRoute = { route: undefined, response: { status: 0, body: '' } }
let handler = (endpoint, payload) => callRoute(mainRoute, endpoint, payload)
const fakeCtx = {
  get(key) {
    if (key === 'subprocess') return fakeSubprocess
    if (key === 'webServer') return makeFakeWebServer(mainRoute)
    if (key === 'connection') return fakeConnection
    return undefined
  },
  effect(fn) {
    fn()
  },
}

apply(fakeCtx, { allowWrite: true, allowPush: false, allowDangerous: true })
if (mainRoute.route === undefined) {
  console.error('插件没有注册 /git-vcs 路由（host 半区没激活？）')
  process.exit(1)
}

const results = []
async function check(label, endpoint, payload, inspect) {
  const result = await handler(endpoint, payload, new AbortController().signal)
  if (result.ok !== true) {
    results.push(`FAIL ${label}: ${result.error.code} ${result.error.message}`)
    return
  }
  const problem = inspect === undefined ? undefined : inspect(result.value)
  results.push(problem === undefined ? `OK   ${label}` : `FAIL ${label}: ${problem}`)
}

const cwd = REPO
/** git 输出的路径分隔符是正斜杠，比较前统一。 */
const samePath = (left, right) => left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()

await check('repo/info', 'repo/info', { cwd }, (value) => {
  if (!samePath(value.repo.root, REPO)) return `root=${value.repo.root}`
  if (value.repo.branch !== 'main') return `branch=${value.repo.branch}`
  if (value.config.allowPush !== false) return 'allowPush 未透传'
  return undefined
})

await check('repo/snapshot 聚合', 'repo/snapshot', { cwd, limit: 5 }, (value) => {
  if (value.repo === null || typeof value.repo !== 'object') return 'repo 缺失'
  if (!samePath(value.repo.root, REPO)) return `root=${value.repo.root}`
  if (!Array.isArray(value.commits) || value.commits.length === 0) return 'commits 为空'
  if (value.branches === null || !Array.isArray(value.branches.local)) return 'branches 缺失'
  if (!Array.isArray(value.stashes)) return 'stashes 不是数组'
  if (!Array.isArray(value.console) || value.console.length === 0) return 'console 为空'
  const bad = value.status.entries.find((entry) => typeof entry.path !== 'string' || entry.path === '')
  return bad === undefined ? undefined : `条目 path 异常：${JSON.stringify(bad)}`
})

await check('remote/list', 'remote/list', { cwd }, (value) => {
  if (!Array.isArray(value.remotes)) return 'remotes 不是数组'
  return undefined
})

await check('status 解析', 'status', { cwd }, (value) => {
  if (!Array.isArray(value.entries)) return 'entries 不是数组'
  if (typeof value.branch.head !== 'string') return 'branch.head 缺失'
  const bad = value.entries.find((entry) => typeof entry.path !== 'string' || entry.path === '')
  return bad === undefined ? undefined : `条目 path 异常：${JSON.stringify(bad)}`
})

await check('log 解析', 'log', { cwd, limit: 5 }, (value) => {
  if (!Array.isArray(value.commits) || value.commits.length === 0) return '没有解析到提交'
  const first = value.commits[0]
  if (typeof first.hash !== 'string' || first.hash.length < 7) return `hash 异常 ${first.hash}`
  if (typeof first.subject !== 'string') return 'subject 缺失'
  return undefined
})

await check('branches 解析', 'branches', { cwd }, (value) => {
  if (!Array.isArray(value.local)) return 'local 不是数组'
  const main = value.local.find((row) => row.name === 'main')
  if (main === undefined) return '没有找到 main 分支'
  // 提交树列靠完整哈希把分支标签钉到提交上，缺了就只能退化成短哈希匹配。
  if (typeof main.hash !== 'string' || main.hash.length < 40) return `分支完整哈希异常：${main.hash}`
  // 符号引用（refs/remotes/origin/HEAD）的 %(refname:short) 会退化成 "origin"，必须过滤掉，
  // 否则远程分支里会同时出现 "origin" 与 "origin/main"。
  const bogus = value.remote.filter((row) => row.name.includes('/') === false)
  if (bogus.length > 0) return `远程分支里有符号引用残留：${bogus.map((row) => row.name).join(', ')}`
  const symbolic = [...value.local, ...value.remote].filter((row) => /(^|\/)HEAD$/.test(row.name))
  return symbolic.length === 0 ? undefined : `仍有 HEAD 符号引用：${symbolic.map((row) => row.name).join(', ')}`
})

await check('snapshot 分支标签可定位提交', 'repo/snapshot', { cwd, limit: 50, consoleLimit: 60 }, (value) => {
  if (!Array.isArray(value.commits) || value.commits.length === 0) return 'commits 为空'
  const hashes = new Set(value.commits.map((row) => row.hash))
  const tips = [...value.branches.local, ...value.branches.remote]
  const matched = tips.filter((row) => hashes.has(row.hash))
  return matched.length === 0 ? '没有任何分支标签能匹配到列表里的提交' : undefined
})

await check('diff 全仓', 'diff', { cwd }, (value) => typeof value.patch === 'string' ? undefined : 'patch 不是字符串')

await check('show 单提交', 'show', { cwd, rev: 'HEAD' }, (value) => {
  if (value.commit === null) return 'commit 元数据为空'
  if (!Array.isArray(value.files)) return 'files 不是数组'
  return undefined
})

await check('console/list', 'console/list', {}, (value) => {
  if (!Array.isArray(value.entries) || value.entries.length === 0) return '命令流水为空'
  const bad = value.entries.find((entry) => !Array.isArray(entry.argv))
  return bad === undefined ? undefined : 'argv 缺失'
})

// 提交详情：默认只拿元数据 + 变更文件（noPatch），单个文件的差异由 show/file 按需拉。
await check('show 不带 patch（noPatch）', 'show', { cwd, rev: 'HEAD', noPatch: true }, (value) => {
  if (value.patch !== '') return `noPatch 时 patch 应为空串，实际 ${value.patch.length} 字节`
  if (!Array.isArray(value.files)) return 'files 不是数组'
  return value.commit === null ? 'commit 元数据为空' : undefined
})

const headDetail = await handler('show', { cwd, rev: 'HEAD', noPatch: true }, new AbortController().signal)
const headFile = headDetail.ok === true && Array.isArray(headDetail.value.files) && headDetail.value.files.length > 0
  ? headDetail.value.files[0].path
  : null
if (headFile === null) {
  results.push('FAIL show/file 单文件差异: HEAD 没有变更文件可测')
} else {
  await check('show/file 单文件差异', 'show/file', { cwd, rev: 'HEAD', path: headFile }, (value) => {
    if (value.path !== headFile) return `path 回显不一致：${value.path}`
    if (typeof value.patch !== 'string' || value.patch.includes('diff --git') === false) return 'patch 不像 diff'
    // 只应包含选中文件，不能把整次提交的所有文件都带上。
    const files = value.patch.split('\ndiff --git ').length
    return files === 1 ? undefined : `patch 含 ${files} 个文件`
  })
  await expectError('show/file 缺 path', 'show/file', { cwd, rev: 'HEAD' }, 'git-vcs/bad-request')
  await expectError('show/file 路径以 - 开头', 'show/file', { cwd, rev: 'HEAD', path: '-x' }, 'git-vcs/bad-request')
}

// 未知端点：必须返回 git-vcs/unknown-endpoint 信封（不抛）。
const unknown = await handler('nope/nope', {}, new AbortController().signal)
if (unknown.ok !== false || unknown.error.code !== 'git-vcs/unknown-endpoint') {
  results.push('FAIL 未知端点未返回 git-vcs/unknown-endpoint')
} else {
  results.push('OK   未知端点返回 git-vcs/unknown-endpoint')
}

// 写操作门禁：allowPush=false 时 push 必须在跑 git 之前就被拒。
const push = await handler('push', { cwd }, new AbortController().signal)
if (push.ok === false && push.error.code === 'git-vcs/push-disabled') results.push('OK   push 被配置门禁拦截')
else results.push(`FAIL push 未被拦截：${JSON.stringify(push).slice(0, 160)}`)

const badCwd = await handler('status', { cwd: 'relative/path' }, new AbortController().signal)
if (badCwd.ok === false && badCwd.error.code === 'git-vcs/bad-request') results.push('OK   相对路径被拒')
else results.push('FAIL 相对路径未被拒')

const outside = await handler('status', { cwd: 'C:\\Windows' }, new AbortController().signal)
if (outside.ok === false && (outside.error.code === 'git-vcs/not-a-repo' || outside.error.code === 'git-vcs/bad-request')) {
  results.push(`OK   非仓库目录被拒（${outside.error.code}）`)
} else {
  results.push(`FAIL 非仓库目录未按预期被拒：${JSON.stringify(outside).slice(0, 160)}`)
}

/* ----------------------------------------- remote/add / remote/remove 端点
 * 用 mkdtemp + 真实 git 建临时仓库；add/remove 是写操作，会改 .git/config，
 * 不能拿真实仓库试。所有断言用与上面同样的 check() 风格，跑完整体 rmSync。
 */
async function expectError(label, endpoint, payload, expectedCode) {
  const result = await handler(endpoint, payload, new AbortController().signal)
  if (result.ok === false && result.error.code === expectedCode) {
    results.push(`OK   ${label}`)
  } else {
    results.push(`FAIL ${label}: 期望 ${expectedCode}，得到 ${JSON.stringify(result).slice(0, 200)}`)
  }
}

const remoteScratch = mkdtempSync(join(tmpdir(), 'gitvcs-remote-'))
function rawGit(args) {
  const r = spawnSync('git', args, { cwd: remoteScratch, env: process.env, stdio: 'ignore', windowsHide: true })
  return r.status
}
/** 读一条 git 命令的标准输出（沙箱下不能用管道抓子进程输出，统一走文件描述符重定向）。 */
function rawGitOut(args) {
  const outPath = join(scratch, `rawgit-${counter++}.txt`)
  const fd = openSync(outPath, 'w')
  spawnSync('git', args, { cwd: remoteScratch, env: process.env, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
  closeSync(fd)
  return readFileSync(outPath, 'utf8').trim()
}
rawGit(['init', '--initial-branch=main', '--quiet'])
rawGit(['config', 'user.email', 'verify@test'])
rawGit(['config', 'user.name', 'verify'])
rawGit(['commit', '--allow-empty', '--quiet', '-m', 'init'])

await expectError('remote/add 缺 name', 'remote/add', { cwd: remoteScratch }, 'git-vcs/bad-request')
await expectError('remote/add 缺 url', 'remote/add', { cwd: remoteScratch, name: 'foo' }, 'git-vcs/bad-request')
await expectError('remote/add 名字非法 ..evil', 'remote/add', { cwd: remoteScratch, name: '..evil', url: 'https://example.com/r.git' }, 'git-vcs/bad-request')

await check('remote/add 正常', 'remote/add', { cwd: remoteScratch, name: 'test-origin', url: 'https://example.com/r.git' }, (value) => {
  if (value === null || value === undefined) return '返回值为空'
  if (value.name !== 'test-origin') return `name=${value.name}`
  if (value.url !== 'https://example.com/r.git') return `url=${value.url}`
  return undefined
})

await check('remote/list 验证 add', 'remote/list', { cwd: remoteScratch }, (value) => {
  const hit = Array.isArray(value.remotes) ? value.remotes.find((r) => r.name === 'test-origin') : undefined
  return hit === undefined ? '新增远程未出现在 list 中' : undefined
})

await expectError('remote/add 重名', 'remote/add', { cwd: remoteScratch, name: 'test-origin', url: 'https://x.com/y.git' }, 'git-vcs/remote-exists')
await expectError('remote/remove 不存在', 'remote/remove', { cwd: remoteScratch, name: 'nope' }, 'git-vcs/remote-not-found')

await check('remote/remove 正常', 'remote/remove', { cwd: remoteScratch, name: 'test-origin' }, (value) => {
  if (value === null || value === undefined) return '返回值为空'
  if (value.removed !== 'test-origin') return `removed=${value.removed}`
  return undefined
})

await check('remote/list 验证 remove', 'remote/list', { cwd: remoteScratch }, (value) => {
  const hit = Array.isArray(value.remotes) ? value.remotes.find((r) => r.name === 'test-origin') : undefined
  return hit === undefined ? undefined : '删除远程仍出现在 list 中'
})

/* ------------------------------------------------- 未跟踪文件的差异（回归）
 * 未跟踪文件不在 index 里，`git diff -- <path>` 恒为空，必须走 host 的 --no-index 分支
 * （客户端要把 untracked 一起转发）。这里把这条链路钉死，避免再出现"列表有它、差异却是空"。
 */
writeFileSync(join(remoteScratch, 'brand-new.txt'), '第一行\n第二行\n', 'utf8')

await check('status 认出未跟踪文件', 'status', { cwd: remoteScratch }, (value) => {
  const hit = Array.isArray(value.entries) ? value.entries.find((entry) => entry.path === 'brand-new.txt') : undefined
  if (hit === undefined) return '未跟踪文件没出现在 status 里'
  return hit.untracked === true ? undefined : `untracked 标记缺失（${JSON.stringify(hit)}）`
})

await check('未跟踪文件：普通 diff 为空（因此必须转发 untracked）', 'diff', { cwd: remoteScratch, path: 'brand-new.txt' }, (value) => (
  value.patch === '' ? undefined : `普通 diff 竟然非空（${value.patch.length} 字节），说明测试前提已变`
))

await check('未跟踪文件：untracked=true 拿到新文件差异', 'diff', { cwd: remoteScratch, path: 'brand-new.txt', untracked: true }, (value) => {
  if (typeof value.patch !== 'string' || value.patch === '') return 'patch 为空'
  if (value.patch.includes('new file mode') === false) return 'patch 不像新文件差异'
  if (value.patch.includes('第二行') === false) return 'patch 没带上文件内容'
  return undefined
})

/* ------------------------------- 带 paths 的提交必须先 add（未跟踪文件回归）
 * `git commit -m msg -- <paths>` 只认 git 已知的路径：路径里有未跟踪文件时整单失败
 * （error: pathspec 'x' did not match any file(s) known to git），连已跟踪的路径也提交不了。
 * host 必须在提交前先 `git add -- <paths>`。
 */
writeFileSync(join(remoteScratch, 'checked-new.txt'), '勾选\n', 'utf8')
writeFileSync(join(remoteScratch, 'unchecked-new.txt'), '未勾选\n', 'utf8')

await check('带未跟踪路径的提交不报 pathspec', 'commit', { cwd: remoteScratch, message: 'verify: 只提勾选的', paths: ['checked-new.txt'] }, (value) => {
  if (typeof value?.stdout !== 'string') return 'stdout 缺失'
  return value.stdout.includes('checked-new.txt') ? undefined : `提交输出没提到该文件（${value.stdout.slice(0, 120)}）`
})

await check('只提交勾选的路径，其余原位不动', 'status', { cwd: remoteScratch }, (value) => {
  const paths = Array.isArray(value.entries) ? value.entries.map((entry) => entry.path) : []
  if (paths.includes('checked-new.txt')) return '勾选的文件提交后仍在改动列表里'
  if (paths.includes('unchecked-new.txt') === false) return '未勾选的未跟踪文件被一起提交了'
  if (paths.includes('brand-new.txt') === false) return '另一个未跟踪文件被一起提交了'
  return undefined
})

/* ------------------------------------------------------- push 的参数构造
 * allowPush 默认关闭，所以要另起一个实例（每个实例自带 handler 与命令流水）。
 * 关键回归：`git push <branch>` 会把分支名当成仓库名，必须显式带 remote。
 */
const pushRoute = { route: undefined, response: { status: 0, body: '' } }
const pushHandler = (endpoint, payload) => callRoute(pushRoute, endpoint, payload)
const pushCtx = {
  get(key) {
    if (key === 'subprocess') return fakeSubprocess
    if (key === 'webServer') return makeFakeWebServer(pushRoute)
    if (key === 'connection') return fakeConnection
    return undefined
  },
  effect(fn) {
    fn()
  },
}
apply(pushCtx, { allowWrite: true, allowPush: true, allowDangerous: true })

const pushCall = (payload) => pushHandler('push', { cwd: remoteScratch, ...payload })
await pushCall({ branch: 'main', remote: 'origin' })
await pushCall({ branch: 'main', remote: 'origin', setUpstream: true })
const pushLog = await pushHandler('console/list', {})
const pushArgvs = pushLog.ok === true ? pushLog.value.entries.map((entry) => entry.argv.join(' ')) : []
if (pushArgvs.includes('git push origin main')) results.push('OK   push 分支时带上 remote（git push origin main）')
else results.push(`FAIL push 未带 remote：${JSON.stringify(pushArgvs.slice(-2))}`)
if (pushArgvs.includes('git push --set-upstream origin main')) results.push('OK   push --set-upstream 带上 remote 与分支')
else results.push(`FAIL push --set-upstream 参数异常：${JSON.stringify(pushArgvs.slice(-2))}`)

const badRemote = await pushCall({ branch: 'main', remote: '--upload-pack=evil' })
if (badRemote.ok === false && badRemote.error.code === 'git-vcs/bad-request') results.push('OK   push 拒绝以 - 开头的 remote')
else results.push(`FAIL push 未拒绝非法 remote：${JSON.stringify(badRemote).slice(0, 160)}`)

// branches 的符号引用过滤：临时仓库里造一个 origin/HEAD 符号引用。
rawGit(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
rawGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
await check('branches 过滤 origin/HEAD 符号引用', 'branches', { cwd: remoteScratch }, (value) => {
  const names = [...value.local, ...value.remote].map((row) => row.name)
  if (names.includes('origin/main') === false) return `没看到 origin/main：${names.join(', ')}`
  return names.includes('origin') === false ? undefined : `符号引用没被过滤：${names.join(', ')}`
})

/* ------------------------------------------------------------ stash 引用回归
 * `stash list` 曾经用 %gd 生成 ref，配上 --date=iso-strict 会变成 `stash@{2026-09-15T…}` 时间戳选择器；
 * git 对那种引用会打印 "Dropped …" 并退出码 0 **却什么都不删**（同秒的两条 ref 还完全一样）。
 * 现在 ref 由列表下标合成 stash@{n}，并对非法引用直接 bad-request。
 */
writeFileSync(join(remoteScratch, 'stashed.txt'), 'v1\n', 'utf8')
rawGit(['add', 'stashed.txt'])
rawGit(['commit', '--quiet', '-m', 'add stashed'])
writeFileSync(join(remoteScratch, 'stashed.txt'), 'v2\n', 'utf8')

await check('stash push 回最新的 stash@{0}', 'stash', { cwd: remoteScratch, action: 'push', message: 'verify' }, (value) => (
  value.ref === 'stash@{0}' ? undefined : `ref=${value.ref}`
))

await check('stash list 的 ref 是 stash@{n}', 'stash', { cwd: remoteScratch, action: 'list' }, (value) => {
  if (!Array.isArray(value.stashes) || value.stashes.length !== 1) return `条数=${value.stashes === undefined ? 'n/a' : value.stashes.length}`
  return /^stash@\{\d+\}$/.test(value.stashes[0].ref) ? undefined : `ref 不是数字选择器：${value.stashes[0].ref}`
})

await expectError('stash drop 拒绝时间戳式坏引用', 'stash', { cwd: remoteScratch, action: 'drop', ref: 'stash@{2026-01-01T00:00:00+08:00}' }, 'git-vcs/bad-request')

await check('stash drop 真的删掉记录', 'stash', { cwd: remoteScratch, action: 'drop', ref: 'stash@{0}' }, () => undefined)

await check('stash drop 之后列表为空', 'stash', { cwd: remoteScratch, action: 'list' }, (value) => (
  Array.isArray(value.stashes) && value.stashes.length === 0 ? undefined : `条数=${value.stashes === undefined ? 'n/a' : value.stashes.length}`
))

/* ---------------------------------------- 提交树覆盖所有分支 + 续拉分页（issue #1 回归）
 * 不带 --all 的 `git log` 只有当前分支的节点，提交树（Log 页签）会漏掉其它分支独有的提交；
 * 带上 --all 之后又必须把 stash 挡在外面（它有独立页签，混进来就是一串认不出归属的节点）。
 * 续拉靠 --skip：首屏 snapshot 与 log 端点必须给出同一个窗口，否则滚到底会重复或跳行。
 */
rawGit(['checkout', '--quiet', '-b', 'feature/tree'])
writeFileSync(join(remoteScratch, 'feature-only.txt'), 'feature\n', 'utf8')
rawGit(['add', 'feature-only.txt'])
rawGit(['commit', '--quiet', '-m', 'feature: 只属于 feature/tree 的提交'])
const featureHash = rawGitOut(['rev-parse', 'feature/tree'])
rawGit(['checkout', '--quiet', 'main'])

await check('提交树覆盖所有分支（all=true）', 'repo/snapshot', { cwd: remoteScratch, limit: 50, all: true }, (value) => {
  const hashes = value.commits.map((row) => row.hash)
  return hashes.includes(featureHash) ? undefined : 'feature/tree 独有的提交没出现在提交树里'
})

await check('不带 all 只有当前分支（回归基线）', 'repo/snapshot', { cwd: remoteScratch, limit: 50 }, (value) => {
  const hashes = value.commits.map((row) => row.hash)
  return hashes.includes(featureHash) === false ? undefined : 'HEAD 之外的提交混进了默认列表，说明 --all 变成了默认'
})

// stash 提交必须被 --exclude=refs/stash 挡在提交树外。
writeFileSync(join(remoteScratch, 'stashed.txt'), 'v3\n', 'utf8')
rawGit(['stash', 'push', '--quiet', '-m', 'tree-check'])
const stashHead = rawGitOut(['rev-parse', 'stash@{0}'])

await check('提交树不含 stash 节点', 'repo/snapshot', { cwd: remoteScratch, limit: 50, all: true }, (value) => {
  const hashes = value.commits.map((row) => row.hash)
  return hashes.includes(stashHead) === false ? undefined : 'stash 的提交混进了提交树'
})
rawGit(['stash', 'drop', '--quiet'])

// 分页：首屏取 2 条，续拉 skip=2 取 2 条，两页拼起来必须与「一次取 4 条」逐字一致。
const logAll = await handler('log', { cwd: remoteScratch, limit: 4, all: true }, new AbortController().signal)
const logPage1 = await handler('repo/snapshot', { cwd: remoteScratch, limit: 2, all: true }, new AbortController().signal)
const logPage2 = await handler('log', { cwd: remoteScratch, limit: 2, skip: 2, all: true }, new AbortController().signal)
if (logAll.ok !== true || logPage1.ok !== true || logPage2.ok !== true) {
  results.push(`FAIL 提交树分页: 端点返回失败 ${JSON.stringify([logAll, logPage1, logPage2]).slice(0, 200)}`)
} else {
  const hashes = (r) => r.value.commits.map((row) => row.hash)
  const full = hashes(logAll)
  const paged = [...hashes(logPage1), ...hashes(logPage2)]
  if (full.length < 4) {
    results.push(`FAIL 提交树分页: 临时仓库提交不足 4 条（${full.length}），用例前提不成立`)
  } else if (JSON.stringify(full) === JSON.stringify(paged)) {
    results.push('OK   提交树续拉与首屏窗口接着（skip 分页不重叠、不跳行）')
  } else {
    results.push(`FAIL 提交树分页串页：一次取=${full.join(',')} 分页取=${paged.join(',')}`)
  }
}

/* ------------------------------------- 未初始化目录 → 一键 git init（issue #2 回归）
 * 空态要成立，host 侧必须满足：非仓库时 snapshot 明确回 not-a-repo；init 能建仓库并让
 * snapshot 立刻可用；重复 init / 嵌套 init / 非法分支名 / allowWrite=false 都要有确定行为。
 */
const initScratch = mkdtempSync(join(tmpdir(), 'gitvcs-init-'))
// 嵌套用例：父目录本身是仓库，子目录里 init 必须被拒（否则会凭空多出一层仓库）。
const nestedParent = mkdtempSync(join(tmpdir(), 'gitvcs-init-nested-'))
const nestedScratch = join(nestedParent, 'inside')

/** 读一条 git 命令的标准输出（同 rawGitOut，但可指定任意 cwd）。 */
function gitOutAt(cwd, args) {
  const outPath = join(scratch, `gitout-${counter++}.txt`)
  const fd = openSync(outPath, 'w')
  spawnSync('git', args, { cwd, env: process.env, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
  closeSync(fd)
  return readFileSync(outPath, 'utf8').trim()
}

await expectError('非仓库目录：repo/snapshot 回 not-a-repo', 'repo/snapshot', { cwd: initScratch, limit: 50, all: true }, 'git-vcs/not-a-repo')

// 初始分支名的期望值：入参 → git config init.defaultBranch → main（与本机配置无关，两种都算对）。
const configuredInitBranch = gitOutAt(REPO, ['config', '--get', 'init.defaultBranch'])
let initValue = null
await check('repo/init 在空目录建仓库', 'repo/init', { cwd: initScratch }, (value) => {
  initValue = value
  if (value.root.replace(/\\/g, '/').toLowerCase() !== initScratch.replace(/\\/g, '/').toLowerCase()) return `root=${value.root}`
  const expected = configuredInitBranch === '' ? 'main' : configuredInitBranch
  if (value.branch !== expected) return `branch=${value.branch}，期望 ${expected}`
  return value.already === false ? undefined : `already=${value.already}`
})

if (existsSync(join(initScratch, '.git')) === false) {
  results.push('FAIL repo/init 之后没有 .git 目录')
} else {
  results.push('OK   repo/init 之后 .git 存在')
}
// home 目录里仓库根的缓存必须没有任何影响：init 后 snapshot 要能直接读到这个新仓库。
results.push(gitOutAt(initScratch, ['symbolic-ref', '--short', 'HEAD']) === (initValue?.branch ?? '')
  ? 'OK   repo/init 之后 HEAD 指向新分支'
  : `FAIL HEAD 指向 ${gitOutAt(initScratch, ['symbolic-ref', '--short', 'HEAD'])}，期望 ${initValue?.branch}`)

await check('repo/init 之后 snapshot 立即可用（空仓库：0 提交、当前分支已就位）', 'repo/snapshot', { cwd: initScratch, limit: 50, all: true }, (value) => {
  if (value.repo.root.replace(/\\/g, '/').toLowerCase() !== initScratch.replace(/\\/g, '/').toLowerCase()) return `root=${value.repo.root}`
  if (Array.isArray(value.commits) === false || value.commits.length !== 0) return `commits=${JSON.stringify(value.commits).slice(0, 80)}`
  if (value.repo.branch !== initValue?.branch) return `branch=${value.repo.branch}，期望 ${initValue?.branch}`
  // 未出生的分支还没有 ref（第一个提交之后才会出现），所以 branches.local 此刻就是空的 —— 这是 git 的语义。
  if (value.repo.detached === true) return '新仓库被判成了 DETACHED'
  if (value.repo.oid !== '' || value.repo.shortHead !== '') return `未出生分支的 oid 没归一：oid=${value.repo.oid} shortHead=${value.repo.shortHead}`
  return undefined
})

await check('重复 repo/init 幂等（already=true，不重复建）', 'repo/init', { cwd: initScratch }, (value) => (
  value.already === true ? undefined : `already=${value.already}`
))

const trunkScratch = mkdtempSync(join(tmpdir(), 'gitvcs-init-trunk-'))
await check('repo/init 支持指定初始分支', 'repo/init', { cwd: trunkScratch, branch: 'trunk' }, (value) => (
  value.branch === 'trunk' ? undefined : `branch=${value.branch}`
))
results.push(gitOutAt(trunkScratch, ['symbolic-ref', '--short', 'HEAD']) === 'trunk'
  ? 'OK   指定分支真的生效（HEAD → trunk）'
  : 'FAIL 指定初始分支没有生效')
await expectError('repo/init 非法分支名被拒', 'repo/init', { cwd: mkdtempSync(join(tmpdir(), 'gitvcs-init-bad-')), branch: 'bad name' }, 'git-vcs/bad-request')
await expectError('repo/init 分支名以 - 开头被拒', 'repo/init', { cwd: mkdtempSync(join(tmpdir(), 'gitvcs-init-dash-')), branch: '-x' }, 'git-vcs/bad-request')

// 已经是仓库根的目录：init 不重复初始化（返回 already），也不该报错。
await check('对已有仓库根 init → already=true', 'repo/init', { cwd: remoteScratch }, (value) => (
  value.already === true ? undefined : `already=${value.already}`
))

// 仓库内部的子目录：必须拒绝，避免凭空造出嵌套仓库。
mkdirSync(nestedScratch, { recursive: true })
gitOutAt(nestedParent, ['init', '--quiet'])
await expectError('仓库内子目录 init 被拒（不造嵌套仓库）', 'repo/init', { cwd: nestedScratch }, 'git-vcs/bad-request')
results.push(existsSync(join(nestedScratch, '.git')) === false
  ? 'OK   被拒的嵌套目录没有留下 .git'
  : 'FAIL 嵌套 init 被拒但仍写下了 .git')

// allowWrite=false：init 是写操作，必须在跑 git 之前就被门禁拦下。
const initRoute = { route: undefined, response: { status: 0, body: '' } }
const initHandler = (endpoint, payload) => callRoute(initRoute, endpoint, payload)
apply({
  get(key) {
    if (key === 'subprocess') return fakeSubprocess
    if (key === 'webServer') return makeFakeWebServer(initRoute)
    if (key === 'connection') return fakeConnection
    return undefined
  },
  effect(fn) { fn() },
}, { allowWrite: false, allowPush: false, allowDangerous: false })
const noWrite = await initHandler('repo/init', { cwd: mkdtempSync(join(tmpdir(), 'gitvcs-init-nowrite-')) }, new AbortController().signal)
if (noWrite.ok === false && noWrite.error.code === 'git-vcs/write-disabled') results.push('OK   allowWrite=false 时 init 被门禁拦截')
else results.push(`FAIL allowWrite=false 时 init 未被拦截：${JSON.stringify(noWrite).slice(0, 160)}`)

rmSync(initScratch, { recursive: true, force: true })
rmSync(trunkScratch, { recursive: true, force: true })

/* ------------------------------------------------------- 凭据保存（credential/approve）
 * 用临时 gitconfig + credential-store 指向临时文件，绝不碰用户真实的 ~/.git-credentials。
 * 注意：某些受限环境（如 DSH 沙箱）凭据助手进程根本起不来（msys sh 建不了信号管道），
 * 那时 stored 会是 false —— 这也是插件要处理的一种真实情况（回退到会话内存凭据），所以不算失败。
 */
const credDir = mkdtempSync(join(tmpdir(), 'gitvcs-cred-'))
const credFile = join(credDir, 'creds')
const cfgFile = join(credDir, 'gitconfig')
writeFileSync(cfgFile, `[credential]\n\thelper = store --file=${credFile.replace(/\\/g, '/')}\n`, 'utf8')
const savedGlobal = process.env.GIT_CONFIG_GLOBAL
const savedSystem = process.env.GIT_CONFIG_SYSTEM
process.env.GIT_CONFIG_GLOBAL = cfgFile
process.env.GIT_CONFIG_SYSTEM = 'NUL'

try {
  await check('credential/approve 返回结构', 'credential/approve', {
    cwd: remoteScratch,
    url: 'https://example.com/owner/repo.git',
    username: 'alice',
    secret: 'tok-123',
  }, (value) => {
    if (value.host !== 'example.com') return `host=${value.host}`
    if (value.username !== 'alice') return `username=${value.username}`
    return typeof value.stored === 'boolean' ? undefined : `stored 类型异常：${typeof value.stored}`
  })

  if (existsSync(credFile)) {    const stored = readFileSync(credFile, 'utf8')
    if (stored.includes('alice') && stored.includes('tok-123') && stored.includes('example.com')) {
      results.push('OK   凭据已写进 credential store（主机级条目）')
    } else {
      results.push(`FAIL 凭据文件内容异常：${stored.slice(0, 100)}`)
    }
  } else {
    results.push('OK   credential store 未落盘（本环境起不了凭据助手，插件会回退到会话内存凭据）')
  }

  await expectError('credential/approve 缺 secret', 'credential/approve', {
    cwd: remoteScratch,
    url: 'https://example.com/owner/repo.git',
    username: 'alice',
  }, 'git-vcs/bad-request')

  await expectError('credential/approve 拒绝 SSH 地址', 'credential/approve', {
    cwd: remoteScratch,
    url: 'git@github.com:owner/repo.git',
    username: 'alice',
    secret: 'tok',
  }, 'git-vcs/bad-request')
} finally {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
  else process.env.GIT_CONFIG_SYSTEM = savedSystem
  rmSync(credDir, { recursive: true, force: true })
}

rmSync(remoteScratch, { recursive: true, force: true })

/* --------------------- 客户端调用的端点必须都在 host 的表里（防改名 / 拼错端点名）
 * 这条是真机踩出来的：客户端发 `repo/init`、host 的键名当时是 `init` → 面板点按钮
 * 毫无反应（只有一条 6 秒就消失的 `git-vcs/unknown-endpoint` toast）。而那时的自检
 * 自己也是拿 `init` 调的，两边一起错、全绿 —— 所以这里不再手写端点名，而是从
 * `lib/client.js` 的字面量里反查 host。
 */
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const calledEndpoints = new Set()
for (const match of clientSource.matchAll(/\b(?:rpc|run|rawCall)\(\s*'([^']+)'/g)) calledEndpoints.add(match[1])
const missingEndpoints = []
for (const name of calledEndpoints) {
  const probe = await handler(name, {}, new AbortController().signal)
  if (probe.ok === false && probe.error.code === 'git-vcs/unknown-endpoint') missingEndpoints.push(name)
}
if (calledEndpoints.size === 0) {
  results.push('FAIL 没能从 lib/client.js 解析出任何端点调用（正则失效？）')
} else if (missingEndpoints.length > 0) {
  results.push(`FAIL 客户端调用了 host 没有的端点：${missingEndpoints.join('、')}`)
} else {
  results.push(`OK   客户端调用的 ${calledEndpoints.size} 个端点 host 侧全部存在`)
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`)
rmSync(scratch, { recursive: true, force: true })
process.exit(failed.length > 0 ? 1 : 0)
