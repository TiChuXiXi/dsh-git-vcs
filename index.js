/**
 * dsh-git-vcs —— host 半区（跑在 DSH host 进程）。
 *
 * 职责：
 *   1. 用 `ctx.subprocess` 以 **argv 形式**（不经 shell）执行 git，输出集中收集；
 *   2. 自己注册 `ctx.webServer` 的 `/git-vcs` 前缀路由（线格式同 Connection RPC，
 *      信任栅栏复用 `ctx.connection.requestRejection`），把端点暴露给浏览器半区；
 *   3. 读插件行的 config 做写操作门禁（allowWrite / allowPush / allowDangerous）。
 *
 * 依赖策略：不 import 任何 @deepseek-ai/* 运行时值，所需服务全部走 `export const inject` 声明 +
 * `ctx.get()` 读取——任一服务缺席即停在 pending（而不是带着 undefined 空转）。
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'

export const name = 'git-vcs'

/**
 * 硬依赖：这三个服务缺一不可（没有 subprocess 跑不了 git，没有 connection 过不了信任栅栏，
 * 没有 webServer 挂不上路由）。
 *
 * 为什么必须是 `inject` 而不是 `inject: []` + `ctx.get()`：
 * loader 按组合顺序挂载行，我们的行排在 base / web-app 之后，但**一次性**在 apply() 里
 * `ctx.get('subprocess')` 会读到 undefined —— 提供方那些行还没就绪（真机日志：
 * `host 半区激活：subprocess=缺席 connection=缺席` → RPC 通道没注册 → 浏览器侧 405）。
 * 声明成 inject 后 cordis 会等服务就绪再激活本插件（缺席则停在 pending，语义正确）。
 * 客户端半区一直声明着 inject，所以它没这个问题 —— 这也是当初定位的关键线索。
 *
 * 行级 inject 也要写（`cordis.patch.yml` 的 `inject:`）：loader 是按**行**激活的，
 * 模块 `export const inject` 管不到行那一层。
 */
export const inject = ['subprocess', 'connection', 'webServer']

/** 插件行 config 的默认值（不导出 Schemastery Config：本插件刻意零运行时依赖）。 */
const DEFAULTS = {
  /** git 可执行文件绝对路径；空 = 从 PATH 解析。 */
  gitPath: '',
  /** 限定可操作的仓库根；空 = 允许任意会话工作目录。 */
  repoRoot: '',
  /** 关闭全部写操作。 */
  allowWrite: true,
  /** 允许 push（默认开，与 IDEA 一致：仓库配好 remote 就能直接推；不想让插件碰远端就置 false）。 */
  allowPush: true,
  /** 允许 reset / revert / cherry-pick / 删分支 / 丢弃改动。 */
  allowDangerous: true,
  /** diff 上下文行数。 */
  diffContextLines: 3,
  /** 单条命令 stdout/stderr 的内存上限（字节）。 */
  maxOutputBytes: 2 * 1024 * 1024,
  /** 单条命令超时（毫秒）。 */
  timeoutMs: 120000,
  /** 面板自动刷新间隔（秒）；0 = 关闭。 */
  autoRefreshSeconds: 0,
  /** Console 保留的命令条数。 */
  consoleLimit: 200,
}

const RPC_CHANNEL = '/git-vcs'
/** 所有 git 调用都带的公共参数：路径不做八进制转义（中文文件名可读）、关掉颜色与外部 diff。 */
const GIT_COMMON = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'diff.noprefix=false']

/** git 执行期的环境：禁交互提示（否则挂起的凭据提示会一直等到超时）。 */
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C.UTF-8',
}

/** 一次 RPC 失败：带稳定错误码，浏览器半区按 code 分支。 */
class GitError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** 合并 config：只接受对象，未知键忽略，数字做范围钳制。 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = input[key]
    if (value === undefined || value === null) continue
    const expected = typeof DEFAULTS[key]
    if (typeof value !== expected) continue
    cfg[key] = value
  }
  cfg.diffContextLines = clampInt(cfg.diffContextLines, 0, 200, DEFAULTS.diffContextLines)
  cfg.maxOutputBytes = clampInt(cfg.maxOutputBytes, 4096, 64 * 1024 * 1024, DEFAULTS.maxOutputBytes)
  cfg.timeoutMs = clampInt(cfg.timeoutMs, 1000, 30 * 60 * 1000, DEFAULTS.timeoutMs)
  cfg.autoRefreshSeconds = clampInt(cfg.autoRefreshSeconds, 0, 3600, DEFAULTS.autoRefreshSeconds)
  cfg.consoleLimit = clampInt(cfg.consoleLimit, 10, 2000, DEFAULTS.consoleLimit)
  return cfg
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const int = Math.trunc(value)
  if (int < min) return min
  if (int > max) return max
  return int
}

/** 路径是否在 root 之内（Windows 大小写不敏感）。 */
function isInside(path, root) {
  const rel = relative(root, path)
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 从 git 的 stderr 归类错误码：调用方按 code 分支，不解析 message。 */
function classify(exitCode, stderr, aborted) {
  if (aborted) return 'git-vcs/timeout'
  const text = stderr.toLowerCase()
  if (text.includes('not a git repository')) return 'git-vcs/not-a-repo'
  if (text.includes('could not resolve host') || text.includes('failed to connect') || text.includes('network is unreachable')) return 'git-vcs/network'
  // 认证缺失 / 被拒：客户端据此弹认证表单（用户名 + 密码或 Token），存进 git 凭据后重推。
  if (AUTH_HINTS.some((hint) => text.includes(hint))) return 'git-vcs/auth-required'
  if (text.includes('automatic merge failed') || text.includes('fix conflicts')) return 'git-vcs/conflict'
  if (text.includes('nothing to commit') || text.includes('no changes added to commit')) return 'git-vcs/nothing-to-commit'
  if (text.includes('non-fast-forward') || text.includes('failed to push some refs') || text.includes('rejected')) return 'git-vcs/push-rejected'
  if (text.includes('please tell me who you are') || text.includes('unable to auto-detect email')) return 'git-vcs/identity-missing'
  if (text.includes('your local changes') || text.includes('would be overwritten')) return 'git-vcs/dirty-worktree'
  if (exitCode === 128) return 'git-vcs/git-failed'
  return 'git-vcs/git-failed'
}

/** 需要认证的特征串（都取小写）。`could not read Username` = 想弹窗但被 GIT_TERMINAL_PROMPT=0 拦住。 */
const AUTH_HINTS = [
  'could not read username',
  'could not read password',
  'terminal prompts disabled',
  'authentication failed',
  'invalid username or password',
  'support for password authentication was removed',
  'permission denied (publickey)',
  '403 forbidden',
  'remote: invalid credentials',
]

/** schannel / 证书上下文拿不到凭据：换 openssl 后端重试通常就好了（不是缺认证信息）。 */
function isSslBackendFailure(stderr) {
  const text = String(stderr).toLowerCase()
  return text.includes('sec_e_no_credentials')
    || text.includes('acquirecredentialshandle')
    || text.includes('schannel:')
}

/** 把 argv / 文本里的 `scheme://user:secret@host` 脱敏：Console 流水与错误详情里不能出现密码。 */
function redactText(value) {
  return String(value).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@')
}

function redactArgv(argv) {
  return Array.isArray(argv) ? argv.map((item) => redactText(item)) : argv
}

/**
 * 拆 http(s) 远程 URL：拿 protocol / host / path / 内嵌 username。
 * 只支持 http(s)（SSH 走密钥，插件不做认证）；返回 null 表示不适合走凭据流程。
 */
function parseRemoteUrl(raw) {
  const text = String(raw).trim()
  const match = /^(https?):\/\/(?:([^/@\s]*)@)?([^/\s:]+(?::\d+)?)(\/[^\s]*)?$/i.exec(text)
  if (match === null) return null
  return {
    protocol: match[1].toLowerCase(),
    username: match[2] === undefined ? '' : decodeURIComponent(match[2]),
    host: match[3],
    path: (match[4] ?? '').replace(/^\//, ''),
  }
}

/** 读一条 collect 模式输出（进程退出后仍可读）。 */
function readCollected(reader) {
  if (reader === undefined) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy, spillPath: read.spillPath }
}

/** 解析 `git status --porcelain=v2 --branch -z`。 */
function parseStatus(stdout) {
  const branch = { oid: '', head: '', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false }
  const entries = []
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '') continue
    if (token.startsWith('# ')) {
      const line = token.slice(2)
      if (line.startsWith('branch.oid ')) branch.oid = line.slice('branch.oid '.length).trim()
      else if (line.startsWith('branch.head ')) {
        branch.head = line.slice('branch.head '.length).trim()
        branch.detached = branch.head === '(detached)'
      } else if (line.startsWith('branch.upstream ')) branch.upstream = line.slice('branch.upstream '.length).trim()
      else if (line.startsWith('branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(line)
        if (match !== null) {
          branch.ahead = Number(match[1])
          branch.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = token[0]
    if (kind === '?') {
      entries.push({ path: token.slice(2), index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, ignored: false, conflicted: false, renamed: false, origPath: null })
      continue
    }
    if (kind === '!') {
      entries.push({ path: token.slice(2), index: '!', worktree: '!', staged: false, unstaged: false, untracked: false, ignored: true, conflicted: false, renamed: false, origPath: null })
      continue
    }
    if (kind === '1' || kind === '2' || kind === 'u') {
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      // porcelain v2：`1 <XY> …<8 个字段> path`、`2 …<9 个字段> path`、`u …<10 个字段> path`。
      const pathIndex = kind === 'u' ? 10 : (kind === '2' ? 9 : 8)
      const path = parts.slice(pathIndex).join(' ')
      let origPath = null
      if (kind === '2') {
        const next = tokens[i + 1]
        if (next !== undefined) {
          origPath = next
          i += 1
        }
      }
      const index = xy[0] ?? '.'
      const worktree = xy[1] ?? '.'
      entries.push({
        path,
        index,
        worktree,
        staged: index !== '.',
        unstaged: worktree !== '.',
        untracked: false,
        ignored: false,
        conflicted: kind === 'u',
        renamed: index === 'R' || worktree === 'R',
        origPath,
      })
      continue
    }
  }
  return { branch, entries }
}

/** 解析 `--pretty=format:LOG_FORMAT` 的输出（末段为提交正文 %b，可能为空）。 */
function parseCommitList(stdout) {
  const commits = []
  for (const chunk of stdout.split('\x1e')) {
    const text = chunk.replace(/^\n+/, '')
    if (text === '') continue
    const parts = text.split('\x1f')
    if (parts.length < 7) continue
    commits.push({
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      email: parts[3],
      date: parts[4],
      parents: parts[5] === '' ? [] : parts[5].split(' '),
      subject: parts[6],
      body: (parts[7] ?? '').trim(),
    })
  }
  return commits
}

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1e'
// 末段 %(objectname) 是完整哈希：Log 的提交树列靠它把「分支标签」钉到对应提交上。
// 再末段 %(symref) 非空表示这是符号引用（典型：refs/remotes/origin/HEAD，它的 %(refname:short)
// 会是 "origin" 而不是 "origin/HEAD"），parseBranchList 会跳过它们。
const BRANCH_FORMAT = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:iso-strict)%1f%(subject)%1f%(objectname)%1f%(symref)'
// 注意：**不要**用 %gd 当 stash 的引用。加了 --date=iso-strict 之后，%gd 会展开成
// `stash@{2026-09-15T14:18:58+08:00}` 这种时间戳选择器，而 `git stash drop <这种 ref>` 会打印
// "Dropped …" 并退出码 0 **却什么都不删**（同秒创建的两条 ref 还会完全一样）。
// 所以这里只取哈希/日期/标题，ref 由 parseStashList 按列表下标合成 `stash@{n}`（列表是最新在前，与 git 的编号一致）。
const STASH_FORMAT = '%H%x1f%ad%x1f%s%x1e'
/** for-each-ref 一次同时取本地与远程分支。 */
const REF_SCOPES = ['refs/heads', 'refs/remotes']

/**
 * 提交历史单次最多返回的条数。浏览器半区 50 条一页懒加载（滚到底续拉），
 * 刷新时按「已加载条数」一次拉回，所以上限同时也是提交树最多渲染的行数。
 */
const LOG_LIMIT_MAX = 2000

/**
 * 提交历史的参数（repo/snapshot 与 log **共用** —— 两处分页必须逐字一致，否则续拉会串页）。
 *
 * `all` 打开后是 `--all`：本地分支 + 远程分支 + 标签全都在（IDEA 的提交树就是这个范围）。
 * 必须同时用 `--exclude=refs/stash` 把 stash 挡在外面：它有独立页签，混进提交树只会变成
 * 一串认不出归属的节点。`--exclude` 只作用于紧随其后的 `--all`，两者必须相邻。
 *
 * 刻意**不加** `--date-order` / `--topo-order`：这两个排序要先把整段可达历史读进内存排序，
 * 大仓库上首屏会明显变慢；git 默认的反向时间序是流式的，配 `-n` / `--skip` 才能做到按需加载。
 */
function logArgs({ limit, skip, all, ref, path }) {
  const args = ['log', '--no-color', '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`]
  if (all === true) args.push('--exclude=refs/stash', '--all')
  if (Number.isInteger(skip) && skip > 0) args.push(`--skip=${skip}`)
  args.push('-n', String(limit))
  if (typeof ref === 'string' && ref !== '') args.push(ref)
  if (typeof path === 'string' && path !== '') args.push('--', path)
  return args
}

/** 解析 `for-each-ref --format=BRANCH_FORMAT` 的输出（本地 / 远程分组）。 */
function parseBranchList(stdout) {
  const local = []
  const remote = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\x1f')
    if (parts.length < 7) continue
    // 符号引用（refs/remotes/origin/HEAD 之类）不是分支：它的 short 名会退化成 "origin"，
    // 留在列表里就会和真正的 origin/main 一起显示成两条远程分支。
    if ((parts[8] ?? '') !== '') continue
    const ahead = /ahead (\d+)/.exec(parts[4])
    const behind = /behind (\d+)/.exec(parts[4])
    const row = {
      ref: parts[0],
      name: parts[1],
      shortHash: parts[2],
      upstream: parts[3],
      ahead: ahead === null ? 0 : Number(ahead[1]),
      behind: behind === null ? 0 : Number(behind[1]),
      date: parts[5],
      subject: parts[6],
      hash: parts[7] ?? '',
      kind: parts[0].startsWith('refs/heads/') ? 'local' : 'remote',
    }
    if (row.kind === 'local') local.push(row)
    else remote.push(row)
  }
  return { local, remote }
}

/**
 * 解析 `stash list --pretty=format:STASH_FORMAT` 的输出。
 * ref 按列表下标合成 `stash@{n}`：`git stash list` 与 reflog 编号一致（最新 = stash@{0}），
 * 比把 `%gd` 直接搬过来可靠（见 STASH_FORMAT 上的说明）。
 */
function parseStashList(stdout) {
  const stashes = []
  for (const chunk of stdout.split('\x1e')) {
    const text = chunk.replace(/^\n+/, '')
    if (text === '') continue
    const parts = text.split('\x1f')
    if (parts.length < 3) continue
    stashes.push({
      ref: `stash@{${stashes.length}}`,
      hash: parts[0],
      date: parts[1],
      subject: parts[2],
    })
  }
  return stashes
}

/** 解析 `git remote -v`：同名远程合并出 fetch / push 两条地址。 */
function parseRemoteList(stdout) {
  const byName = new Map()
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const name = line.slice(0, tab)
    const rest = line.slice(tab + 1)
    const at = rest.lastIndexOf(' (')
    const url = (at < 0 ? rest : rest.slice(0, at)).trim()
    const kind = at < 0 ? '' : rest.slice(at + 2).replace(')', '').trim()
    let item = byName.get(name)
    if (item === undefined) {
      item = { name, fetch: '', push: '' }
      byName.set(name, item)
    }
    if (kind === 'push') item.push = url
    else item.fetch = url
  }
  return [...byName.values()]
}

/** 缓存键：Windows 路径大小写不敏感。 */
function cacheKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const subprocess = ctx.get('subprocess')
  const connection = ctx.get('connection')
  const webServer = ctx.get('webServer')

  console.log(`[dsh-git-vcs] host 半区激活：subprocess=${subprocess === undefined ? '缺席' : '就绪'} connection=${connection === undefined ? '缺席' : '就绪'}`)
  console.log(`[dsh-git-vcs] 配置：allowWrite=${config.allowWrite} allowPush=${config.allowPush} allowDangerous=${config.allowDangerous} gitPath=${config.gitPath === '' ? '(PATH)' : config.gitPath} repoRoot=${config.repoRoot === '' ? '(未限定)' : config.repoRoot}`)

  if (subprocess === undefined) {
    console.warn('[dsh-git-vcs] ctx.subprocess 缺席：无法执行 git，RPC 通道未注册。')
    return
  }

  /** Console 环形缓冲：每次 git 调用一条。 */
  const commandLog = []
  let resolvedGit = null
  /** 仓库根缓存：cacheKey(cwd) → rev-parse --show-toplevel 的结果，省掉每次端点的探测进程。 */
  const rootCache = new Map()
  /** remote.origin.url 缓存：cacheKey(root) → url。 */
  const remoteUrlCache = new Map()
  /** git --version 是进程级常量，只取一次。 */
  let cachedGitVersion = null
  /** 本会话内存里的远程凭据：host → { username, secret }。凭据助手不可用时的兜底，进程结束即消失。 */
  const sessionCredentials = new Map()

  async function resolveGit(signal) {
    if (config.gitPath !== '') return config.gitPath
    if (resolvedGit !== null) return resolvedGit
    resolvedGit = await subprocess.resolveExecutable('git', undefined, signal)
    return resolvedGit
  }

  /** remote.origin.url（按仓库根缓存一次）。 */
  async function remoteUrlOf(root, signal) {
    const key = cacheKey(root)
    if (remoteUrlCache.has(key)) return remoteUrlCache.get(key)
    const result = await runGit(['config', '--get', 'remote.origin.url'], { cwd: root, signal })
    const url = result.exitCode === 0 ? result.stdout.trim() : ''
    remoteUrlCache.set(key, url)
    return url
  }

  /** git 版本（进程级缓存一次）。 */
  async function gitVersionOf(root, signal) {
    if (cachedGitVersion !== null) return cachedGitVersion
    const result = await runGit(['--version'], { cwd: root, signal })
    cachedGitVersion = result.exitCode === 0 ? result.stdout.trim() : ''
    return cachedGitVersion
  }

  /**
   * 执行一次 git。永不因非零退出 throw（由调用方用 gitOk 判定），只有 spawn 失败/超时 throw。
   * `stdin` 可传字符串（凭据走 stdin，不进 argv，Console 流水里就不会留下密码）；
   * `config` 是 `-c key=value` 列表，必须排在子命令之前。
   * @returns {{argv: string[], exitCode: number|null, stdout: string, stderr: string, durationMs: number, aborted: boolean}}
   */
  async function runGit(args, { cwd, signal, stdin, config: extraConfig, sensitive }) {
    const executable = await resolveGit(signal)
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const startedAt = Date.now()
    const configArgs = []
    for (const entry of extraConfig ?? []) configArgs.push('-c', entry)
    const handle = subprocess.spawn({
      argv: [executable, ...GIT_COMMON, ...configArgs, ...args],
      cwd,
      stdio: {
        stdin: typeof stdin === 'string' ? { data: stdin } : 'ignore',
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: config.maxOutputBytes },
      },
      graceMs: 5000,
      signal: bound,
      env: GIT_ENV,
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (cause) {
      throw new GitError('git-vcs/spawn-failed', `无法启动 git：${cause instanceof Error ? cause.message : String(cause)}`, {
        argv: redactArgv(['git', ...args]),
      })
    }
    const stdout = readCollected(handle.collected.stdout)
    const stderr = readCollected(handle.collected.stderr)
    const durationMs = Date.now() - startedAt
    const record = {
      at: startedAt,
      // 敏感调用（凭据 approve/fill、内嵌凭据的推送）不进流水：argv 脱敏、输出隐藏。
      argv: redactArgv(['git', ...args]),
      exitCode: outcome.exitCode,
      durationMs,
      stdout: sensitive === true ? '（凭据相关命令，输出已隐藏）' : stdout.text,
      stderr: sensitive === true ? '' : stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      timeout: timeout.aborted,
    }
    commandLog.push(record)
    while (commandLog.length > config.consoleLimit) commandLog.shift()
    return {
      argv: record.argv,
      exitCode: outcome.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: record.truncated,
      durationMs,
      aborted: bound.aborted,
      timedOut: timeout.aborted,
    }
  }

  /** 非零退出即抛 GitError（按 stderr 归类）。 */
  function gitOk(result, { allowExit = [0] } = {}) {
    if (result.exitCode !== null && allowExit.includes(result.exitCode)) return result
    const stderr = redactText(result.stderr.trim())
    const stdout = redactText(result.stdout.trim())
    throw new GitError(
      result.timedOut ? 'git-vcs/timeout' : classify(result.exitCode, stderr, result.aborted),
      stderr !== '' ? stderr : (stdout !== '' ? stdout : `git 退出码 ${result.exitCode}`),
      { argv: redactArgv(result.argv), exitCode: result.exitCode },
    )
  }

  /** 凭据查询块（git credential 的 stdin 协议）：不传 path，存成主机级，符合"认证一次后续都顺畅"。 */
  function credentialBlock(target, { username, secret }) {
    const lines = [`protocol=${target.protocol}`, `host=${target.host}`]
    if (typeof username === 'string' && username !== '') lines.push(`username=${username}`)
    if (typeof secret === 'string') lines.push(`password=${secret}`)
    return `${lines.join('\n')}\n`
  }

  /**
   * 把认证信息交给 git 的凭据助手保存（store → `~/.git-credentials`，manager → 系统凭据库）。
   *
   * 密码只走 stdin（不进 argv、不进 Console 流水）；保存后用 `git credential fill` 回读校验，
   * 因为 `git credential approve` 即使没人接收也返回 0（助手缺失时是静默失败）。
   * 同时把凭据记在本进程内存里，供本次会话内"助手不可用时直接内嵌凭据推送"兜底。
   */
  async function approveCredential(root, url, username, secret, signal) {
    const target = parseRemoteUrl(url)
    if (target === null) {
      throw new GitError('git-vcs/bad-request', `只有 http(s) 远程需要账号密码：${url}`)
    }
    const approve = await runGit(['credential', 'approve'], {
      cwd: root,
      signal,
      stdin: credentialBlock(target, { username, secret }),
      sensitive: true,
    })
    gitOk(approve)
    sessionCredentials.set(target.host, { username, secret })
    // 回读校验：助手没保存成功时 fill 会读不到（或返回空）。
    const fill = await runGit(['credential', 'fill'], {
      cwd: root,
      signal,
      stdin: `${`protocol=${target.protocol}\nhost=${target.host}\n`}`,
      sensitive: true,
    })
    const stored = fill.exitCode === 0 && fill.stdout.includes('password=') && fill.stdout.includes(`username=${username}`)
    return { host: target.host, username, stored }
  }

  /** 内嵌凭据的推送 URL（仅在助手不可用时兜底；argv 会在流水里脱敏）。 */
  function credentialUrl(url, credential) {
    const target = parseRemoteUrl(url)
    if (target === null) return null
    const user = encodeURIComponent(credential.username)
    const pass = encodeURIComponent(credential.secret)
    return `${target.protocol}://${user}:${pass}@${target.host}/${target.path}`
  }

  /**
   * 这次推送到底打到哪个远程：显式 remote 名 → 当前分支配置的 branch.<name>.remote → origin。
   * @returns {{name: string, url: string, host: string} | null}
   */
  async function resolvePushTarget(root, remoteName, signal) {
    const candidates = []
    if (typeof remoteName === 'string' && remoteName !== '') candidates.push(remoteName)
    const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal })
    const branchName = head.exitCode === 0 ? head.stdout.trim() : ''
    if (branchName !== '' && branchName !== 'HEAD') {
      const configured = await runGit(['config', '--get', `branch.${branchName}.remote`], { cwd: root, signal })
      const name = configured.exitCode === 0 ? configured.stdout.trim() : ''
      if (name !== '') candidates.push(name)
    }
    candidates.push('origin')
    for (const name of candidates) {
      const result = await runGit(['remote', 'get-url', name], { cwd: root, signal })
      const url = result.exitCode === 0 ? result.stdout.trim() : ''
      if (url === '') continue
      const target = parseRemoteUrl(url)
      if (target === null) return null
      return { name, url, host: target.host }
    }
    return null
  }

  /** 解析并校验 cwd：绝对路径、存在、是目录、在 repoRoot 之下、确为 git 工作树。 */
  async function ensureWorkdir(rawCwd, signal) {
    if (typeof rawCwd !== 'string' || rawCwd.trim() === '') {
      throw new GitError('git-vcs/bad-request', '缺少 cwd（会话工作目录）')
    }
    if (!isAbsolute(rawCwd)) {
      throw new GitError('git-vcs/bad-request', `cwd 必须是绝对路径：${rawCwd}`)
    }
    const cwd = resolvePath(rawCwd)
    if (config.repoRoot !== '') {
      const root = resolvePath(config.repoRoot)
      const same = process.platform === 'win32' ? cwd.toLowerCase() === root.toLowerCase() : cwd === root
      const inside = process.platform === 'win32' ? isInside(cwd.toLowerCase(), root.toLowerCase()) : isInside(cwd, root)
      if (!same && !inside) {
        throw new GitError('git-vcs/outside-root', `路径不在允许的仓库根内：${cwd}`, { repoRoot: root })
      }
    }
    const info = await stat(cwd).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      throw new GitError('git-vcs/bad-request', `工作目录不存在或不是目录：${cwd}`)
    }
    const key = cacheKey(cwd)
    const cached = rootCache.get(key)
    if (cached !== undefined) return { cwd, root: cached }
    const top = await runGit(['rev-parse', '--show-toplevel'], { cwd, signal })
    if (top.exitCode !== 0) {
      throw new GitError('git-vcs/not-a-repo', `不是 git 仓库：${cwd}`, { cwd })
    }
    const root = top.stdout.trim()
    rootCache.set(key, root)
    rootCache.set(cacheKey(root), root)
    return { cwd, root }
  }

  function requireWrite() {
    if (!config.allowWrite) {
      throw new GitError('git-vcs/write-disabled', '写操作已被插件配置关闭（allowWrite=false）')
    }
  }

  function requirePush() {
    requireWrite()
    if (!config.allowPush) {
      throw new GitError('git-vcs/push-disabled', 'push 已被插件配置关闭（allowPush=false）')
    }
  }

  function requireDangerous() {
    requireWrite()
    if (!config.allowDangerous) {
      throw new GitError('git-vcs/dangerous-disabled', '危险操作已被插件配置关闭（allowDangerous=false）')
    }
  }

  /** 取要操作的路径数组（JSON 兼容校验）。 */
  function readPaths(payload) {
    const paths = payload?.paths
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || p === '' || p.includes('\0'))) {
      throw new GitError('git-vcs/bad-request', 'paths 必须是非空字符串数组')
    }
    return paths
  }

  /** 取可选 / 必填的文件路径：不接受空串、NUL 与以 - 开头的值（避免被 git 当成参数）。 */
  function readFilePath(payload, optional = false) {
    const raw = payload?.path
    if (raw === undefined || raw === null || raw === '') {
      if (optional === true) return null
      throw new GitError('git-vcs/bad-request', '缺少 path')
    }
    if (typeof raw !== 'string' || raw.includes('\0') || raw.startsWith('-')) {
      throw new GitError('git-vcs/bad-request', 'path 非法')
    }
    return raw
  }

  /** 取 push 的 remote 参数：缺省 origin，拒绝空串 / 空白 / NUL / 以 - 开头。 */
  function readRemoteArg(raw) {
    if (raw === undefined || raw === null || raw === '') return 'origin'
    if (typeof raw !== 'string') throw new GitError('git-vcs/bad-request', 'remote 必须是字符串')
    const name = raw.trim()
    if (name === '' || name.includes('\0') || name.startsWith('-') || /\s/.test(name)) {
      throw new GitError('git-vcs/bad-request', `remote 非法：${raw}`)
    }
    return name
  }

  /** 取 stash 的引用：只接受 `stash@{n}` 或 40 位十六进制哈希（坏引用会让 git 静默什么都不做）。 */
  function readStashRef(payload) {
    const ref = readRef(payload, 'ref')
    if (/^stash@\{\d+\}$/.test(ref) || /^[0-9a-f]{7,40}$/.test(ref)) return ref
    throw new GitError('git-vcs/bad-request', `stash 引用非法：${ref}（应为 stash@{n} 或提交哈希）`)
  }

  function readRef(payload, key = 'ref') {
    const ref = payload?.[key]
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw new GitError('git-vcs/bad-request', `${key} 必须是非空字符串`)
    }
    if (ref.startsWith('-')) {
      throw new GitError('git-vcs/bad-request', `${key} 不能以 - 开头`)
    }
    return ref
  }

  function readMessage(payload) {
    const message = payload?.message
    if (typeof message !== 'string' || message.trim() === '') {
      throw new GitError('git-vcs/bad-request', '提交信息不能为空')
    }
    return message
  }

  /** 校验远程名：trim 后非空、不以 - 开头、不含空白与 git 保留字符、不以 . 结尾且不含 ..。 */
  function readRemoteName(payload) {
    const raw = payload?.name
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new GitError('git-vcs/bad-request', '远程名不能为空')
    }
    const name = raw.trim()
    if (name.includes('\0')) throw new GitError('git-vcs/bad-request', '远程名含非法字符')
    if (name.startsWith('-')) throw new GitError('git-vcs/bad-request', '远程名不能以 - 开头')
    if (/[\s]/.test(name)) throw new GitError('git-vcs/bad-request', '远程名不能含空白')
    if (/[:?*~\\\[\]\^]/.test(name)) throw new GitError('git-vcs/bad-request', `远程名含 git 保留字符：${name}`)
    if (name.endsWith('.') || name.includes('..')) throw new GitError('git-vcs/bad-request', `远程名不能以 . 结尾或包含 ..`)
    return name
  }

  /** 必填 URL：非空、trim、不含控制字符（scheme 合法性交给 git 自身报 git-vcs/git-failed）。 */
  function readUrl(payload, key = 'url') {
    const raw = payload?.[key]
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new GitError('git-vcs/bad-request', `${key} 不能为空`)
    }
    const value = raw.trim()
    if (value.includes('\0')) throw new GitError('git-vcs/bad-request', `${key} 含非法字符`)
    return value
  }

  /** 可选 URL：空 / 未传 → null；其它与 readUrl 同样校验。 */
  function readOptionalUrl(payload, key) {
    const raw = payload?.[key]
    if (typeof raw !== 'string') return null
    if (raw.trim() === '') return null
    return readUrl({ [key]: raw }, key)
  }

  /** 一次 status 调用（repo/info 与 status 端点共用）。 */
  async function statusOf(cwd, signal) {
    const result = gitOk(await runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd, signal }))
    return parseStatus(result.stdout)
  }

  /** 生效配置：浏览器半区据此决定按钮可用性。 */
  function configView() {
    return {
      allowWrite: config.allowWrite,
      allowPush: config.allowPush,
      allowDangerous: config.allowDangerous,
      diffContextLines: config.diffContextLines,
      autoRefreshSeconds: config.autoRefreshSeconds,
    }
  }

  const endpoints = {
    /** 仓库总览 + 生效配置（分支/领先落后由一次 status 给出，省掉两次 rev-parse）。 */
    async 'repo/info'(payload, signal) {
      const { cwd, root } = await ensureWorkdir(payload?.cwd, signal)
      const [status, remoteUrl, gitVersion] = await Promise.all([
        statusOf(root, signal),
        remoteUrlOf(root, signal),
        gitVersionOf(root, signal),
      ])
      const branchName = status.branch.head !== '' ? status.branch.head : status.branch.oid
      return {
        repo: {
          cwd,
          root,
          branch: branchName,
          detached: status.branch.detached || branchName === 'HEAD',
          shortHead: status.branch.oid.slice(0, 7),
          oid: status.branch.oid,
          upstream: status.branch.upstream,
          ahead: status.branch.ahead,
          behind: status.branch.behind,
          remoteUrl,
          gitVersion,
        },
        config: configView(),
      }
    },

    /**
     * 面板首屏聚合端点：repo/info + status + log + branches + stash + console 合成一次往返。
     * 6 个 git 探测全部并发——单次刷新的进程创建从约 16 次（6 次往返、串行）降到 6 次同波。
     *
     * `all: true` 时提交树覆盖**所有分支**的节点（见 logArgs）；`limit` 由浏览器半区按
     * 「已加载条数」给，刷新不会把滚到深处的提交树缩回一页。
     */
    async 'repo/snapshot'(payload, signal) {
      const { cwd, root } = await ensureWorkdir(payload?.cwd, signal)
      const limit = clampInt(Number.isInteger(payload?.limit) ? payload.limit : 50, 1, LOG_LIMIT_MAX, 50)
      const consoleLimit = clampInt(Number.isInteger(payload?.consoleLimit) ? payload.consoleLimit : 60, 1, config.consoleLimit, 60)
      const [statusResult, logResult, branchResult, stashResult, remoteUrl, gitVersion] = await Promise.all([
        runGit(['status', '--porcelain=v2', '--branch', '-z'], { cwd: root, signal }),
        runGit(logArgs({ limit, all: payload?.all === true }), { cwd: root, signal }),
        runGit(['for-each-ref', `--format=${BRANCH_FORMAT}`, ...REF_SCOPES], { cwd: root, signal }),
        runGit(['stash', 'list', '--date=iso-strict', `--pretty=format:${STASH_FORMAT}`], { cwd: root, signal }),
        remoteUrlOf(root, signal),
        gitVersionOf(root, signal),
      ])
      const status = parseStatus(gitOk(statusResult).stdout)
      const branchName = status.branch.head !== '' ? status.branch.head : status.branch.oid
      const noCommits = logResult.exitCode !== 0 && logResult.stderr.includes('does not have any commits')
      return {
        repo: {
          cwd,
          root,
          branch: branchName,
          detached: status.branch.detached || branchName === 'HEAD',
          shortHead: status.branch.oid.slice(0, 7),
          oid: status.branch.oid,
          upstream: status.branch.upstream,
          ahead: status.branch.ahead,
          behind: status.branch.behind,
          remoteUrl,
          gitVersion,
        },
        config: configView(),
        status,
        commits: noCommits ? [] : parseCommitList(logResult.stdout),
        branches: branchResult.exitCode === 0 ? parseBranchList(branchResult.stdout) : { local: [], remote: [] },
        stashes: stashResult.exitCode === 0 ? parseStashList(stashResult.stdout) : [],
        console: commandLog.slice(-consoleLimit).map((entry) => ({ ...entry })),
      }
    },

    /** 把当前目录初始化为 git 仓库（IDEA 的 "Add project to VCS"）。 */
    async init(payload, signal) {
      requireWrite()
      const raw = payload?.cwd
      if (typeof raw !== 'string' || !isAbsolute(raw)) {
        throw new GitError('git-vcs/bad-request', 'cwd 必须是绝对路径')
      }
      const cwd = resolvePath(raw)
      const info = await stat(cwd).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) {
        throw new GitError('git-vcs/bad-request', `目录不存在：${cwd}`)
      }
      const result = gitOk(await runGit(['init'], { cwd, signal }))
      // 刚初始化出来的仓库：把根写进缓存，省掉后续端点的一次探测。
      rootCache.set(cacheKey(cwd), cwd)
      remoteUrlCache.delete(cacheKey(cwd))
      return { root: cwd, message: result.stdout.trim() }
    },

    /** 变更列表（含分支跟踪信息）。 */
    async status(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      return statusOf(root, signal)
    },

    /** 单个文件的统一 diff；untracked 走 --no-index（退出码 1 表示有差异）。 */
    async diff(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const filePath = payload?.path
      const context = Number.isInteger(payload?.context) ? payload.context : config.diffContextLines
      const args = ['diff', '--no-color', '--no-ext-diff', `-U${clampInt(context, 0, 200, config.diffContextLines)}`]
      if (payload?.staged === true) args.push('--cached')
      if (typeof payload?.rev === 'string' && payload.rev !== '') args.push(readRef(payload, 'rev'))
      args.push('--')
      if (typeof filePath === 'string' && filePath !== '') {
        if (filePath.includes('\0')) throw new GitError('git-vcs/bad-request', 'path 非法')
        args.push(filePath)
      }
      if (payload?.untracked === true) {
        const result = await runGit(['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', String(filePath)], { cwd: root, signal })
        gitOk(result, { allowExit: [0, 1] })
        return { patch: result.stdout, empty: result.stdout.trim() === '', argv: result.argv }
      }
      const result = gitOk(await runGit(args, { cwd: root, signal }), { allowExit: [0, 1] })
      return { patch: result.stdout, empty: result.stdout.trim() === '', argv: result.argv }
    },

    /**
     * 提交历史（提交树续拉走这里：`skip` = 已加载条数，`all` = 覆盖所有分支）。
     * 参数构造与 repo/snapshot 共用 logArgs —— 分页要与首屏逐字一致，否则会重叠或跳行。
     */
    async log(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const limit = clampInt(Number.isInteger(payload?.limit) ? payload.limit : 50, 1, LOG_LIMIT_MAX, 50)
      const branch = payload?.branch
      const filePath = payload?.path
      const result = await runGit(logArgs({
        limit,
        skip: Number.isInteger(payload?.skip) ? payload.skip : 0,
        all: payload?.all === true,
        ref: typeof branch === 'string' && branch !== '' ? readRef(payload, 'branch') : '',
        path: typeof filePath === 'string' && filePath !== '' ? filePath : '',
      }), { cwd: root, signal })
      if (result.exitCode !== 0 && result.stderr.includes('does not have any commits')) return { commits: [] }
      gitOk(result)
      return { commits: parseCommitList(result.stdout) }
    },

    /** 单个提交：元数据 + 变更文件 + patch。 */
    async show(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const rev = readRef(payload, 'rev')
      const filePath = readFilePath(payload, true)
      // 详情面板默认只列变更文件，patch 由 show/file 按需拉：noPatch 时省掉一次 git show 与整包传输。
      const wantPatch = payload?.noPatch !== true
      const nameArgs = ['show', '--no-color', '--format=', '--name-status', rev]
      const patchArgs = ['show', '--no-color', '--format=', `-U${config.diffContextLines}`, rev]
      if (filePath !== null) {
        nameArgs.push('--', filePath)
        patchArgs.push('--', filePath)
      }
      // 三段探测并发：点一次提交只等一波进程创建。
      const probes = [
        runGit(['show', '--no-color', '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`, '--no-patch', rev], { cwd: root, signal }),
        runGit(nameArgs, { cwd: root, signal }),
      ]
      if (wantPatch) probes.push(runGit(patchArgs, { cwd: root, signal }))
      const [meta, nameStatus, patch] = await Promise.all(probes)
      const commits = parseCommitList(gitOk(meta).stdout)
      const files = []
      for (const line of gitOk(nameStatus).stdout.split('\n')) {
        if (line.trim() === '') continue
        const parts = line.split('\t')
        if (parts.length < 2) continue
        files.push({ status: parts[0], path: parts[parts.length - 1], origPath: parts.length > 2 ? parts[1] : null })
      }
      if (wantPatch) gitOk(patch)
      return { commit: commits[0] ?? null, files, patch: wantPatch ? patch.stdout : '' }
    },

    /** 单文件在某次提交里的差异：详情面板点开某个变更文件时才拉，避免一次拉整次提交的 patch。 */
    async 'show/file'(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const rev = readRef(payload, 'rev')
      const filePath = readFilePath(payload)
      const args = ['show', '--no-color', '--format=', `-U${config.diffContextLines}`, rev, '--', filePath]
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { patch: result.stdout, path: filePath }
    },

    /** 本地 + 远程分支。 */
    async branches(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const result = gitOk(await runGit(['for-each-ref', `--format=${BRANCH_FORMAT}`, ...REF_SCOPES], { cwd: root, signal }))
      return parseBranchList(result.stdout)
    },

    /** 远程仓库列表（git remote -v）：同名远程合并 fetch / push 两条地址。 */
    async 'remote/list'(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const result = gitOk(await runGit(['remote', '-v'], { cwd: root, signal }))
      return { remotes: parseRemoteList(result.stdout), root }
    },

    /**
     * 添加远程仓库：name + url；push 与 fetch 不同时再走 `remote set-url --push`。
     * 可选带上 `username` / `secret`：添加时就把认证信息交给 git 凭据助手存起来（IDEA 的"添加时认证"），
     * 之后 push 不用再填。
     */
    async 'remote/add'(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const name = readRemoteName(payload)
      const url = readUrl(payload, 'url')
      const push = readOptionalUrl(payload, 'push')
      // 重名检测：git remote get-url 退出码 0 表示已存在。
      const exists = await runGit(['remote', 'get-url', name], { cwd: root, signal })
      if (exists.exitCode === 0) {
        throw new GitError('git-vcs/remote-exists', `远程已存在：${name}`)
      }
      gitOk(await runGit(['remote', 'add', name, url], { cwd: root, signal }))
      if (push !== null && push !== url) {
        gitOk(await runGit(['remote', 'set-url', '--push', name, push], { cwd: root, signal }))
      }
      // 失效缓存：repo/info 与 remote/list 各自缓存了 remote.origin.url 等。
      remoteUrlCache.delete(cacheKey(root))
      // 带了认证信息就顺手存进凭据助手（失败也只警告，不影响 remote 已加好的事实）。
      let credential = null
      if (typeof payload?.username === 'string' && payload.username !== '' && typeof payload?.secret === 'string' && payload.secret !== '') {
        try {
          credential = await approveCredential(root, url, payload.username, payload.secret, signal)
        } catch (cause) {
          console.warn(`[dsh-git-vcs] 保存远程凭据失败：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      return { name, url, push: push ?? url, credential }
    },

    /** 删除远程仓库：先 `get-url` 校验存在，再 `remote remove`。 */
    async 'remote/remove'(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const name = readRemoteName(payload)
      const exists = await runGit(['remote', 'get-url', name], { cwd: root, signal })
      if (exists.exitCode !== 0) {
        throw new GitError('git-vcs/remote-not-found', `远程不存在：${name}`)
      }
      gitOk(await runGit(['remote', 'remove', name], { cwd: root, signal }))
      remoteUrlCache.delete(cacheKey(root))
      return { removed: name }
    },

    /** 暂存（git add）。 */
    async stage(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const args = payload?.all === true ? ['add', '-A'] : ['add', '--', ...readPaths(payload)]
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { argv: result.argv, stdout: result.stdout }
    },

    /** 取消暂存（git restore --staged）。 */
    async unstage(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const args = payload?.all === true ? ['restore', '--staged', '--', '.'] : ['restore', '--staged', '--', ...readPaths(payload)]
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { argv: result.argv, stdout: result.stdout }
    },

    /** 丢弃工作区改动（危险）：未跟踪文件走 clean，其余走 restore。 */
    async discard(payload, signal) {
      requireDangerous()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const paths = readPaths(payload)
      const tracked = []
      const untracked = []
      for (const p of paths) {
        const check = await runGit(['ls-files', '--error-unmatch', '--', p], { cwd: root, signal })
        if (check.exitCode === 0) tracked.push(p)
        else untracked.push(p)
      }
      if (tracked.length > 0) gitOk(await runGit(['restore', '--', ...tracked], { cwd: root, signal }))
      if (untracked.length > 0) gitOk(await runGit(['clean', '-f', '--', ...untracked], { cwd: root, signal }))
      return { restored: tracked, removed: untracked }
    },

    /** 提交（可选 amend）。调用方通常先 stage。 */
    async commit(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const message = readMessage(payload)
      const args = ['commit', '-m', message]
      if (payload?.amend === true) args.push('--amend')
      if (payload?.signoff === true) args.push('--signoff')
      const hasPaths = Array.isArray(payload?.paths) && payload.paths.length > 0
      const paths = hasPaths ? readPaths(payload) : []
      // pathspec 形式的提交只认 git 已知的路径：未跟踪文件不先 add 会整单失败
      // （error: pathspec 'x' did not match any file(s) known to git），
      // 连已跟踪的那些路径也一起提交不了。所以带 paths 时先暂存这些路径。
      if (hasPaths) {
        gitOk(await runGit(['add', '--', ...paths], { cwd: root, signal }))
        args.push('--', ...paths)
      }
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /** 切换分支 / 检出引用（create=true 时新建并切换）。 */
    async checkout(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const ref = readRef(payload)
      const args = payload?.create === true ? ['checkout', '-b', ref] : ['checkout', ref]
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /** 新建分支（不切换）。 */
    async 'branch/create'(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const name = readRef(payload, 'name')
      const args = ['branch', name]
      if (typeof payload?.startPoint === 'string' && payload.startPoint !== '') args.push(readRef(payload, 'startPoint'))
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { stdout: result.stdout }
    },

    /** 删除分支（危险）。 */
    async 'branch/delete'(payload, signal) {
      requireDangerous()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const name = readRef(payload, 'name')
      const args = ['branch', payload?.force === true ? '-D' : '-d', name]
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /** 合并一个引用到当前分支。 */
    async merge(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const ref = readRef(payload)
      const result = await runGit(['merge', '--no-edit', ref], { cwd: root, signal })
      gitOk(result)
      return { stdout: result.stdout, stderr: result.stderr }
    },

    async fetch(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const args = ['fetch', '--prune']
      if (typeof payload?.remote === 'string' && payload.remote !== '') args.push(readRef(payload, 'remote'))
      const result = gitOk(await runGit(args, { cwd: root, signal }))
      return { stdout: result.stdout, stderr: result.stderr }
    },

    async pull(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const result = await runGit(['pull', '--no-edit'], { cwd: root, signal })
      gitOk(result)
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /**
     * 保存远程认证信息（用户名 + 密码/Token）到 git 凭据助手，并记进本会话内存。
     * 客户端在"推送失败提示需要认证"或"添加远程时填了账号"时调用；密码只走 stdin。
     */
    async 'credential/approve'(payload, signal) {
      requireWrite()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const url = readUrl(payload, 'url')
      const username = typeof payload?.username === 'string' ? payload.username.trim() : ''
      if (username === '') throw new GitError('git-vcs/bad-request', 'username 不能为空')
      const secret = typeof payload?.secret === 'string' ? payload.secret : ''
      if (secret === '') throw new GitError('git-vcs/bad-request', 'secret（密码或 Token）不能为空')
      return await approveCredential(root, url, username, secret, signal)
    },

    /**
     * 推送。流程对齐 IDEA：
     *   1. 先按当前配置直接推（仓库通常已经配好 remote 与凭据助手）；
     *   2. 若失败原因是 schannel 拿不到凭据上下文 → 换 openssl 后端自动重试一次（第一次没改动远端，重试安全）；
     *   3. 若失败原因是缺认证信息 → 回 `git-vcs/auth-required`，客户端弹认证表单，
     *      填完走 `credential/approve` 存进 git 全局凭据后再推（第二次调用本端点）；
     *   4. 其余（网络不通、被拒、无权限等）原样回错误码与 stderr，不在插件里猜。
     */
    async push(payload, signal) {
      requirePush()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      // 允许调用方显式指定 SSL 后端（配置项之外的临时覆盖）。
      const backend = typeof payload?.sslBackend === 'string' && payload.sslBackend !== '' ? payload.sslBackend : null
      const config = backend === null ? [] : [`http.sslBackend=${backend}`]
      const branch = typeof payload?.branch === 'string' && payload.branch !== '' ? readRef(payload, 'branch') : null
      const args = ['push']
      if (branch !== null) {
        // 必须显式给出 remote：`git push <branch>` 会把分支名当成仓库名（"does not appear to be a git repository"）。
        const remote = readRemoteArg(payload?.remote)
        if (payload?.setUpstream === true) args.push('--set-upstream', remote, branch)
        else args.push(remote, branch)
      }
      const first = await runGit(args, { cwd: root, signal, config })
      if (first.exitCode === 0) {
        return { stdout: first.stdout, stderr: first.stderr, sslBackend: backend === null ? 'default' : backend, retried: false }
      }
      // schannel 类失败：用 openssl 重试一次（若调用方已经指定了后端就不再来回切换）。
      if (backend === null && isSslBackendFailure(first.stderr)) {
        const retry = await runGit(args, { cwd: root, signal, config: ['http.sslBackend=openssl'] })
        if (retry.exitCode === 0) {
          console.log('[dsh-git-vcs] schannel 失败，已用 http.sslBackend=openssl 重试成功')
          return { stdout: retry.stdout, stderr: retry.stderr, sslBackend: 'openssl', retried: true }
        }
        gitOk(retry)
      }
      // 缺认证信息：若本次会话里已经有该主机的凭据（用户刚在认证表单里填过），内嵌凭据再推一次兜底。
      if (classify(first.exitCode, first.stderr, first.aborted) === 'git-vcs/auth-required') {
        const target = await resolvePushTarget(root, payload?.remote, signal)
        const credential = target === null ? undefined : sessionCredentials.get(target.host)
        if (target !== null && credential !== undefined) {
          const authedUrl = credentialUrl(target.url, credential)
          if (authedUrl !== null) {
            const retryArgs = branch === null
              ? ['push', authedUrl]
              : ['push', ...(payload?.setUpstream === true ? ['--set-upstream'] : []), authedUrl, branch]
            const retry = await runGit(retryArgs, { cwd: root, signal, config, sensitive: true })
            if (retry.exitCode === 0) {
              console.log('[dsh-git-vcs] 凭据助手不可用，已用内存凭据（内嵌 URL）推送成功')
              return {
                stdout: retry.stdout,
                stderr: retry.stderr,
                sslBackend: backend === null ? 'default' : backend,
                retried: true,
                usedSessionCredential: true,
              }
            }
            gitOk(retry)
          }
        }
      }
      gitOk(first)
      return { stdout: first.stdout, stderr: first.stderr, sslBackend: 'default', retried: false }
    },

    /** 贮藏（stash）操作。 */
    async stash(payload, signal) {
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const action = payload?.action
      if (action === 'list') {
        const result = gitOk(await runGit(['stash', 'list', '--date=iso-strict', `--pretty=format:${STASH_FORMAT}`], { cwd: root, signal }))
        return { stashes: parseStashList(result.stdout) }
      }
      requireWrite()
      if (action === 'push') {
        const args = ['stash', 'push']
        if (typeof payload?.message === 'string' && payload.message !== '') args.push('-m', payload.message)
        const result = gitOk(await runGit(args, { cwd: root, signal }))
        // 记录这次 push 后的最新引用，便于调用方确认（drop/pop 用 stash@{n} 编号）。
        return { stdout: result.stdout, ref: 'stash@{0}' }
      }
      if (action === 'pop' || action === 'apply' || action === 'drop') {
        const ref = readStashRef(payload)
        const countStashes = async () => {
          const out = gitOk(await runGit(['stash', 'list', '--pretty=format:%H'], { cwd: root, signal })).stdout.trim()
          return out === '' ? 0 : out.split('\n').length
        }
        const before = await countStashes()
        const result = await runGit(['stash', action, ref], { cwd: root, signal })
        gitOk(result)
        const after = await countStashes()
        // git 对过期/坏引用会打印 "Dropped …" 却什么都不删（退出码 0），必须核对条数才能把静默失败变成明确错误：
        // apply 之后条数应不变；pop / drop 之后应恰好少一条。
        const expectedAfter = action === 'apply' ? before : before - 1
        if (after !== expectedAfter) {
          throw new GitError(
            'git-vcs/git-failed',
            `git stash ${action} 没有生效：贮藏条数 ${before} → ${after}（应为 ${expectedAfter}），引用可能已过期：${ref}`,
            { ref, before, after },
          )
        }
        return { stdout: result.stdout, stderr: result.stderr, ref }
      }
      throw new GitError('git-vcs/bad-request', `未知的 stash action：${String(action)}`)
    },

    /** 回滚一个提交（生成反向提交，危险）。 */
    async revert(payload, signal) {
      requireDangerous()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const rev = readRef(payload, 'rev')
      const result = await runGit(['revert', '--no-edit', rev], { cwd: root, signal })
      gitOk(result)
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /** 拣选一个提交（危险）。 */
    async 'cherry-pick'(payload, signal) {
      requireDangerous()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const rev = readRef(payload, 'rev')
      const result = await runGit(['cherry-pick', rev], { cwd: root, signal })
      gitOk(result)
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /** 重置到某个提交（危险，mode = soft | mixed | hard）。 */
    async reset(payload, signal) {
      requireDangerous()
      const { root } = await ensureWorkdir(payload?.cwd, signal)
      const rev = readRef(payload, 'rev')
      const mode = payload?.mode
      if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') {
        throw new GitError('git-vcs/bad-request', 'mode 必须是 soft | mixed | hard')
      }
      const result = await runGit(['reset', `--${mode}`, rev], { cwd: root, signal })
      gitOk(result)
      return { stdout: result.stdout, stderr: result.stderr }
    },

    /** Console 数据：最近的 git 调用。 */
    async 'console/list'(payload) {
      const limit = clampInt(Number.isInteger(payload?.limit) ? payload.limit : 100, 1, config.consoleLimit, 100)
      return { entries: commandLog.slice(-limit).map((entry) => ({ ...entry })) }
    },

    /** 清空 Console。 */
    async 'console/clear'() {
      commandLog.length = 0
      return { cleared: true }
    },
  }

  const handler = async (endpoint, payload, signal) => {
    const fn = endpoints[endpoint]
    if (fn === undefined) {
      return { ok: false, error: { code: 'git-vcs/unknown-endpoint', message: `未知端点：${String(endpoint)}`, details: {} } }
    }
    try {
      const value = await fn(payload ?? {}, signal)
      return { ok: true, value }
    } catch (cause) {
      if (cause instanceof GitError) {
        return { ok: false, error: { code: cause.code, message: cause.message, details: cause.details } }
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      console.warn(`[dsh-git-vcs] 端点 ${endpoint} 失败：${message}`)
      return { ok: false, error: { code: 'git-vcs/internal', message, details: {} } }
    }
  }

  if (connection === undefined || webServer === undefined) {
    console.warn(`[dsh-git-vcs] ctx.connection / ctx.webServer 缺席：RPC 通道 ${RPC_CHANNEL} 未注册，浏览器半区将拿不到数据。`)
    return
  }

  /*
   * 为什么自己注册 webServer 路由，而不用 `connection.rpc.handle(channel, handler)`：
   *   · 那个 API 把路由注册到 **connection 服务自己的 ctx** 的 `webServer` 上，而 web-app 的
   *     connection 行只 inject 了 [webRuntime]，于是任何第三方调用都会炸
   *     `cannot get property "webServer" without inject`（不只是我们的问题，是这版 dsh 的空档）；
   *   · 官方推荐的共享通道 `connection.rpc.intercept('/api', …)` 是**单占位**（api-gateway 已经占了，
   *     再注册会抛 already has an interceptor）。
   * 所以我们自己注册一条 prefix 路由，并复用 connection 服务公开的 `requestRejection()` 做
   * 信任栅栏（Host/Origin + 浏览器会话认证），线格式保持与 Connection RPC 完全一致：
   *   请求  { type:"client-request", rpcId, method, payload }
   *   响应  { type:"server-response", rpcId, result: { ok:true, value } | { ok:false, error } }
   * 浏览器侧照旧用 `ctx.connection.rpc.call('/git-vcs', endpoint, payload)`。
   */
  async function readJsonBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > config.maxOutputBytes) throw new GitError('git-vcs/bad-request', '请求体过大')
      chunks.push(chunk)
    }
    if (size === 0) return null
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  function respondJson(response, status, value) {
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: async (request, response) => {
      const rejection = connection.requestRejection(request)
      if (rejection !== undefined) {
        response.writeHead(rejection)
        response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      let message = null
      try {
        message = await readJsonBody(request)
      } catch (cause) {
        respondJson(response, 400, {
          type: 'server-response',
          rpcId: 'invalid-request',
          result: { ok: false, error: { code: 'git-vcs/bad-request', message: cause instanceof Error ? cause.message : String(cause), details: {} } },
        })
        return
      }
      const rpcId = message !== null && typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const method = message !== null && typeof message.method === 'string' ? message.method : ''
      const payload = message !== null && message.payload !== null && typeof message.payload === 'object' ? message.payload : {}
      const result = await handler(method, payload, undefined)
      respondJson(response, 200, { type: 'server-response', rpcId, result })
    },
  }), 'dsh-git-vcs: rpc channel')
  console.log(`[dsh-git-vcs] RPC 通道已注册：${RPC_CHANNEL}`)
}
