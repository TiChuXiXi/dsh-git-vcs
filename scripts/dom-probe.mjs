/**
 * 浏览器半区的**真机几何自检**：用本机已装的 Chrome/Edge 起一个 headless 实例，加载一个临时页面
 * （内联 React UMD + 真实 `lib/client.js` + 夹具数据），把面板挂起来后通过 CDP 取回
 * **渲染出来的像素几何**做断言。
 *
 * 为什么需要它：`scripts/render-probe.mjs` 的迷你 React 只走到 props（没有布局引擎），
 * 而 SVG / 百分比 / replaced element 的坑**只在真正的布局引擎里**才暴露。真机就撞过两次：
 *   · `<svg>` 只给 top/left/right/bottom 时高度是 auto，浏览器按 viewBox 固有比例（28:100）
 *     把高度算成 100px —— 斜线被放大成三行多、落到下面几行去，整棵树错位；
 *   · 2px 宽的连线 div 以泳道中心为 left、圆心也在泳道中心 —— 线比圆点整体偏右 1px。
 *
 * 用法：node scripts/dom-probe.mjs
 * 依赖：本机有 Chrome/Edge；`.npm-cache/domprobe` 里装了 react/react-dom（缺了会提示并跳过）。
 *
 * 注意：本机沙箱禁止命名管道，Chrome 的渲染进程会 `FATAL platform_channel 拒绝访问` 直接死掉，
 * 所以这个脚本要在**放宽权限**（danger-full-access）或沙箱外运行；缺浏览器/缺 React 时自动跳过。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, '.npm-cache', 'domprobe')
/** 默认测仓库里的 lib/client.js；用 DOM_PROBE_CLIENT 可以指向另一份产物做前后对照。 */
const CLIENT = process.env.DOM_PROBE_CLIENT ?? join(ROOT, 'lib', 'client.js')
const PORT = Number(process.env.DOM_PROBE_PORT ?? 9337)
const DEBUG = process.argv.includes('--debug')
/** 可选：`--repo <路径>` 用真实仓库的数据在真浏览器里再跑一遍提交树（默认跳过）。 */
const REPO = (() => {
  const at = process.argv.indexOf('--repo')
  return at > 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : null
})()

/**
 * 用与 host 半区逐字一致的 git 参数读一份仓库快照（提交 + 分支），供 `--repo` 模式使用。
 * 只读，不改仓库状态。
 */
function readSnapshot(repoPath) {
  const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1e'
  const BRANCH_FORMAT = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:iso-strict)%1f%(subject)%1f%(objectname)%1f%(symref)'
  const git = (args) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const commits = []
  for (const chunk of git(['log', '--no-color', '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`, '--exclude=refs/stash', '--all', '-n', '2000']).split('\x1e')) {
    const text = chunk.replace(/^\n+/, '')
    if (text === '') continue
    const parts = text.split('\x1f')
    if (parts.length < 7) continue
    commits.push({
      hash: parts[0], shortHash: parts[1], author: parts[2], email: parts[3], date: parts[4],
      parents: parts[5] === '' ? [] : parts[5].split(' '), subject: parts[6], body: (parts[7] ?? '').trim(),
    })
  }
  const local = []
  const remote = []
  for (const line of git(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']).split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\x1f')
    if (parts.length < 7 || (parts[8] ?? '') !== '') continue
    const ahead = /ahead (\d+)/.exec(parts[4])
    const behind = /behind (\d+)/.exec(parts[4])
    const row = {
      ref: parts[0], name: parts[1], shortHash: parts[2], upstream: parts[3],
      ahead: ahead === null ? 0 : Number(ahead[1]), behind: behind === null ? 0 : Number(behind[1]),
      date: parts[5], subject: parts[6], hash: parts[7] ?? '',
      kind: parts[0].startsWith('refs/heads/') ? 'local' : 'remote',
    }
    if (row.kind === 'local') local.push(row)
    else remote.push(row)
  }
  const headBranch = (() => {
    try {
      return git(['symbolic-ref', '--short', 'HEAD']).trim()
    } catch {
      return ''
    }
  })()
  const branch = headBranch === '' ? null : (local.find((item) => item.name === headBranch) ?? null)
  const head = commits.length === 0 ? '' : commits[0]
  return {
    repo: {
      cwd: repoPath, root: repoPath, branch: branch === null ? '' : branch.name, detached: branch === null,
      shortHead: head === '' ? '' : head.shortHash, oid: head === '' ? '' : head.hash,
      upstream: '', ahead: 0, behind: 0, remoteUrl: '', gitVersion: '',
    },
    config: { allowWrite: true, allowPush: false, allowDangerous: true, diffContextLines: 3, autoRefreshSeconds: 0 },
    status: { branch: { oid: head === '' ? '' : head.hash, head: branch === null ? '' : branch.name, upstream: '', ahead: 0, behind: 0, detached: branch === null }, entries: [] },
    commits, branches: { local, remote }, stashes: [], console: [],
  }
}

const realSnapshot = REPO === null ? null : readSnapshot(REPO)

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const browser = BROWSERS.find((path) => path !== '' && existsSync(path))
const react = join(SCRATCH, 'node_modules', 'react', 'umd', 'react.production.min.js')
const reactDom = join(SCRATCH, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js')
if (browser === undefined) {
  console.log('跳过：本机没找到 Chrome/Edge（真机几何自检需要浏览器）')
  process.exit(0)
}
if (existsSync(react) === false || existsSync(reactDom) === false) {
  console.log(`跳过：缺少 react/react-dom。先装：npm install --prefix ${SCRATCH} --registry=https://registry.npmjs.org react@18.3.1 react-dom@18.3.1`)
  process.exit(0)
}

/* ------------------------------------------------------------------ 夹具（与 render-probe 同一套拓扑）
 * 0/1 = test/x（1 的父提交是 4）、2/3 = main（3 的父提交是 4）、4 = 分叉提交、
 * 5 = 合并提交（父提交 6 与 7 → 一条分出斜线）、6 = 主线、7 = 另一条线的根。
 * 分支名只有 main / test/x，所以调色板是 main=0(蓝) / test/x=1(绿)。
 */
const LANE_GAP = 14
const fixture = `
const mk = (i, subject, parents) => ({
  hash: String(i).padStart(2, '0').repeat(20), shortHash: String(i).padStart(2, '0').repeat(20).slice(0, 7),
  author: 'probe', email: 'probe@test', date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  parents: parents.map((p) => String(p).padStart(2, '0').repeat(20)), subject, body: '',
})
const commits = [
  mk(0, 'test tip', [1]), mk(1, 'test only', [4]),
  mk(2, 'main tip', [3]), mk(3, 'main before fork', [4]),
  mk(4, 'fork commit', [5]), mk(5, 'merge commit', [6, 7]),
  mk(6, 'main below merge', [7]), mk(7, 'other root', []),
]
const branches = {
  local: [
    { ref: 'refs/heads/main', name: 'main', hash: commits[2].hash, shortHash: commits[2].shortHash, kind: 'local', upstream: '', ahead: 0, behind: 0, date: commits[2].date, subject: commits[2].subject },
    { ref: 'refs/heads/test/x', name: 'test/x', hash: commits[0].hash, shortHash: commits[0].shortHash, kind: 'local', upstream: '', ahead: 0, behind: 0, date: commits[0].date, subject: commits[0].subject },
  ],
  remote: [],
}
const value = {
  repo: { cwd: 'D:/fixture', root: 'D:/fixture', branch: 'main', detached: false, shortHead: commits[2].shortHash, oid: commits[2].hash, upstream: '', ahead: 0, behind: 0, remoteUrl: '', gitVersion: '' },
  config: { allowWrite: true, allowPush: true, allowDangerous: true, diffContextLines: 3, autoRefreshSeconds: 0 },
  status: { branch: { oid: commits[2].hash, head: 'main', upstream: '', ahead: 0, behind: 0, detached: false }, entries: [] },
  commits, branches, stashes: [], console: [],
}

/* --------- mode = 'merge'：合并线回归夹具（certbase-offline 的拓扑形状）
 * 顺序：main tip(0) → cust tip(1) → merge(2) → cust work(3) → main below merge(4) → root(5)。
 * merge(2) 的两个父提交是 cust work(3) 与 main below merge(4)，而 'main below merge' 早被
 * 主干泳道（lane 0）期待 —— 这正是旧算法"向右突出又折返"的场景（它会多开一条 lane 2）。
 * 另外给 'cust tip' 挂 4 个远程分支（含超长名）用来验标签截断与 +N。
 */
const mergeCommits = [
  mk(0, 'main tip', [4]), mk(1, 'cust tip', [2]),
  mk(2, 'merge cust into main', [3, 4]), mk(3, 'cust work', [5]),
  mk(4, 'main below merge', [5]),
  // 末行的父提交故意不放进窗口（模拟浅克隆 / 已到 2000 行渲染上限后的截断）：
  // 已经取全的情况下，这条线永远等不到节点，不该在列表底部留一条断头线。
  mk(5, 'root', [6]),
]
const lb = (name, commit) => ({ ref: 'refs/heads/' + name, name, hash: commit.hash, shortHash: commit.shortHash, kind: 'local', upstream: '', ahead: 0, behind: 0, date: commit.date, subject: commit.subject })
const rb = (name, commit) => ({ ref: 'refs/remotes/' + name, name, hash: commit.hash, shortHash: commit.shortHash, kind: 'remote', upstream: '', ahead: 0, behind: 0, date: commit.date, subject: commit.subject })
const mergeBranches = {
  local: [lb('main', mergeCommits[0])],
  remote: [
    rb('origin/customer/guizhou-bianjian', mergeCommits[1]),
    rb('origin/feature/a-very-long-branch-name', mergeCommits[1]),
    rb('origin/release/2026-09-candidate', mergeCommits[1]),
    rb('origin/dev', mergeCommits[1]),
  ],
}
const mergeValue = {
  repo: { cwd: 'D:/fixture', root: 'D:/fixture', branch: 'main', detached: false, shortHead: mergeCommits[0].shortHash, oid: mergeCommits[0].hash, upstream: '', ahead: 0, behind: 0, remoteUrl: '', gitVersion: '' },
  config: { allowWrite: true, allowPush: true, allowDangerous: true, diffContextLines: 3, autoRefreshSeconds: 0 },
  status: { branch: { oid: mergeCommits[0].hash, head: 'main', upstream: '', ahead: 0, behind: 0, detached: false }, entries: [] },
  commits: mergeCommits, branches: mergeBranches, stashes: [], console: [],
}
const activeValue = window.__mode === 'real' ? window.__realValue
  : (window.__mode === 'merge' ? mergeValue : value)

window.__initCalls = 0
window.__initPayload = null
window.__inited = false
// mode = 'no-repo'：先让 repo/snapshot 回 not-a-repo（面板该走空态），repo/init 成功后恢复正常。
// 注意实参顺序：客户端拿到的 face.call 已经闭包了 CHANNEL，它转手调
// ctx.connection.rpc.call(CHANNEL, endpoint, payload) —— 所以这层的第一个参数是 channel。
const call = async (channel, endpoint, payload) => {
  if (window.__mode === 'no-repo') {
    if (endpoint === 'repo/init') {
      window.__initCalls += 1
      window.__initPayload = payload
      window.__inited = true
      return { ok: true, value: { root: 'D:/fixture', branch: (payload && payload.branch) || 'main', already: false, message: 'Initialized empty Git repository in D:/fixture/.git/' } }
    }
    if (window.__inited !== true) {
      return { ok: false, error: { code: 'git-vcs/not-a-repo', message: '不是 git 仓库：D:/fixture', details: { cwd: 'D:/fixture' } } }
    }
  }
  // 点提交行会拉 'show'：回一个带 commit 的载荷，提交详情里的「分支」一行才有得渲染。
  if (endpoint === 'show') {
    const found = activeValue.commits.find((item) => item.hash === (payload && payload.rev))
    return { ok: true, value: { commit: found === undefined ? null : found, files: [], patch: '' } }
  }
  return { ok: true, value: activeValue }
}
`

const pageScript = `
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
// 页面里的异常（React 渲染错误是异步抛的，不会走到下面的 try/catch）收集起来一起回传，
// 否则只会看到"root 里什么都没有"这种二手症状。
window.__errors = []
window.addEventListener('error', (event) => window.__errors.push(String(event.message || (event.error && event.error.stack) || event.error)))
window.addEventListener('unhandledrejection', (event) => window.__errors.push('unhandledrejection: ' + String(event.reason)))
const half = window.__entry.factory((name) => {
  if (name === 'react') return window.React
  throw new Error('未提供的模块 ' + name)
})
let GitBody = null
let face = null
half.apply({
  effect: (fn) => fn(),
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (name, fn) => fn(),
    register: (spec, component) => { if (spec.name === 'sidebar.right.pane.tab') { GitBody = component; face = spec.inject } return () => {} },
  },
  connection: { rpc: { call } },
})
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(GitBody, {
  ...face(),
  useSessions: () => ({ current: 's1', byId: { s1: { cwd: 'D:/fixture' } } }),
}))
await wait(700)

const rect = (node) => {
  const box = node.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }
}
const buttonTexts = () => [...document.querySelectorAll('button')].map((node) => (node.textContent || '').trim())
const panelBox = () => rect(document.getElementById('root').firstElementChild)

/* ---------------------------------------------------------- 未初始化仓库：整页空态 */
if (window.__mode === 'no-repo') {
  const rootEl = document.getElementById('root').firstElementChild
  if (rootEl === null) return { error: 'no-repo 模式下面板根节点没渲染出来：' + JSON.stringify(window.__errors) }
  const emptyWrap = () => [...rootEl.children].find((node) => (node.textContent || '').includes('不是 Git 仓库'))
  const first = emptyWrap()
  const openBtn = first === undefined ? null : [...first.querySelectorAll('button')].find((node) => (node.textContent || '').includes('初始化 Git 仓库'))
  const before = {
    tabs: buttonTexts(),
    emptyText: first === undefined ? '' : (first.textContent || ''),
    emptyBox: first === undefined ? null : rect(first),
    panelBox: panelBox(),
    pathBarBox: rootEl.children.length === 0 ? null : rect(rootEl.children[0]),
    emptyButtons: first === undefined ? -1 : first.querySelectorAll('button').length,
    initBox: openBtn === null ? null : rect(openBtn),
    graphRows: [...document.querySelectorAll('div[title]')].filter((row) => row.querySelector('svg[width="12"]') !== null).length,
  }

  // 第一下：只展开分支名选择，还不能发 repo/init。
  if (openBtn !== null) { openBtn.click(); await wait(300) }
  const ask = emptyWrap()
  const branchInput = ask === undefined ? null : ask.querySelector('input')
  const chips = ask === undefined ? [] : [...ask.querySelectorAll('button')].map((node) => (node.textContent || '').trim())
  const chooser = {
    shown: ask !== undefined && branchInput !== null,
    branchValue: branchInput === null ? null : branchInput.value,
    chips,
    initCallsAfterOpen: window.__initCalls,
  }
  // 选备选 master → 输入框要跟着变；再点「初始化」才真的发请求。
  if (ask !== undefined) {
    const masterChip = [...ask.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'master')
    if (masterChip !== undefined) { masterChip.click(); await wait(200) }
  }
  const afterChip = emptyWrap()
  const chipInput = afterChip === undefined ? null : afterChip.querySelector('input')
  chooser.valueAfterChip = chipInput === null ? null : chipInput.value
  const goBtn = afterChip === undefined ? null : [...afterChip.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === '初始化')
  if (goBtn !== null) { goBtn.click(); await wait(900) }
  return {
    before,
    chooser,
    after: {
      tabs: buttonTexts(),
      emptyGone: emptyWrap() === undefined,
      initCalls: window.__initCalls,
      initPayload: window.__initPayload,
    },
  }
}

/* ------------------------------------------------------------ 有仓库：提交树几何 */
const logTab = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Log')
if (logTab === undefined) return { error: '没找到 Log 页签按钮' }
logTab.click()
await wait(400)

const commitRows = () => [...document.querySelectorAll('div[title]')].filter((row) => {
  // 提交行的标志：行样式带 cursor: pointer **且**含 12px 的圆点 SVG
  //（提交树单元格自己也有 title，分支标签、工具栏按钮也会被 div[title] 捞到，都要排掉）
  if ((row.getAttribute('style') ?? '').includes('cursor: pointer') === false) return false
  return row.querySelector('svg[width="12"]') !== null
})

const collectRows = () => commitRows().map((row) => {
  const laneBox = row.querySelector('div[style*="position: relative"]')
  const cell = laneBox === null ? null : laneBox.parentElement
  const chips = cell === null ? null : cell.children[1]
  const svgs = [...row.querySelectorAll('svg')]
  // 斜线是**两条横带**（汇入 / 岔出各一条，几何用 calc(50% ± 4px) 精确算），
  // 标志：viewBox 纵向是 100 的那两张。
  const bands = svgs.filter((node) => (node.getAttribute('viewBox') ?? '').split(' ')[3] === '100')
  const dotSvg = svgs.find((node) => node.getAttribute('width') === '12')
  return {
    subject: row.getAttribute('title'),
    row: rect(row),
    laneBox: rect(laneBox),
    cell: cell === null ? null : rect(cell),
    chips: chips === null || chips === undefined
      ? []
      : [...chips.children].map((chip) => ({ text: chip.textContent || '', title: chip.getAttribute('title') || '', width: rect(chip).width })),
    bands: bands.map((node) => ({ box: rect(node), lines: [...node.querySelectorAll('line')].map((line) => rect(line)) })),
    dot: dotSvg === undefined ? null : rect(dotSvg),
    verticals: [...row.querySelectorAll('div')]
      .filter((node) => (node.getAttribute('style') ?? '').includes('width: 2px'))
      .map((node) => rect(node)),
    diagonals: bands.flatMap((node) => [...node.querySelectorAll('line')].map((line) => rect(line))),
  }
})

/* --------- 合并线回归（mode = merge）：几何 + 标签截断 + 提交详情的分支清单 */
if (window.__mode === 'merge') {
  const before = collectRows()
  // 点一下挂满远程分支的那一行，看提交详情里的「分支」一行
  const target = commitRows().find((row) => row.getAttribute('title') === 'cust tip')
  if (target !== undefined) { target.click(); await wait(500) }
  const branchRow = [...document.querySelectorAll('div')]
    .find((node) => (node.textContent || '').startsWith('分支 · ') && node.children.length > 0)
  return {
    rows: before,
    branchRow: branchRow === undefined
      ? null
      : {
        text: branchRow.textContent || '',
        chips: [...branchRow.children].map((chip) => ({ text: chip.textContent || '', width: rect(chip).width })),
      },
    detailText: branchRow === undefined ? '' : (branchRow.parentElement.textContent || ''),
  }
}

return { rows: collectRows(), bodyText: document.body.innerText.slice(0, 200) }
`

/* ------------------------------------------------------------------ 页面 + 浏览器 */

mkdirSync(SCRATCH, { recursive: true })

/** 跑一次页面（mode = 'normal' | 'no-repo' | 'merge'），返回页面里探针的返回值。 */
async function runProbe(mode, port) {
  const pagePath = join(SCRATCH, `harness-${mode}.html`)
  writeFileSync(pagePath, [
    '<!doctype html><html><head><meta charset="utf-8">',
    // #root 给固定高度：面板本来就是撑满侧栏的，而且空态的"垂直居中"只有给了高度才测得出来。
    '<style>html,body{margin:0;padding:0;font:12px/1.5 sans-serif;background:#fff} #root{width:760px;height:600px}</style>',
    '</head><body><div id="root"></div>',
    '<script>window.__ModuleLoader__ = { load: (spec) => { window.__entry = spec } }</script>',
    `<script>${readFileSync(react, 'utf8')}</script>`,
    `<script>${readFileSync(reactDom, 'utf8')}</script>`,
    `<script>${readFileSync(CLIENT, 'utf8')}</script>`,
    `<script>window.__mode = ${JSON.stringify(mode)}</script>`,
    // 真实仓库数据（`--repo` 时才有）：单独一段脚本注入，避免拼进夹具字符串里转义出错。
    `<script>window.__realValue = ${realSnapshot === null ? 'null' : JSON.stringify(realSnapshot)}</script>`,
    `<script>${fixture}</script>`,
    `<script>window.__probe = (async () => { try { ${pageScript} } catch (cause) { return { error: String((cause && cause.stack) || cause) } } })()</script>`,
    '</body></html>',
  ].join('\n'), 'utf8')

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${join(SCRATCH, `profile-${mode}`)}`,
    `file:///${pagePath.replace(/\\/g, '/')}`,
  ], { stdio: 'ignore', windowsHide: true })
  try {
    return await readProbe(port, `harness-${mode}.html`)
  } finally {
    child.kill()
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 等页面里的探针 promise 出结果；期间轮询 CDP 的页面 target。 */
async function readProbe(port, page) {
  let lastError = 'CDP 没有响应'
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const target = list.find((item) => item.type === 'page' && String(item.url).includes(page))
      if (target !== undefined) {
        const value = await evaluate(target.webSocketDebuggerUrl, 'window.__probe', true)
        if (value !== undefined) return value
        if (DEBUG) {
          const diagnosis = await evaluate(target.webSocketDebuggerUrl, `JSON.stringify({
            ready: document.readyState,
            react: typeof window.React,
            reactDom: typeof window.ReactDOM,
            entry: typeof window.__entry,
            children: (document.getElementById('root') || {}).childElementCount,
            body: document.body.innerText.slice(0, 200),
          })`, false)
          console.log('诊断：', diagnosis)
        }
      }
    } catch (cause) {
      lastError = String(cause?.message ?? cause)
    }
    await sleep(300)
  }
  return { error: `取不回探针结果：${lastError}` }
}

function evaluate(webSocketDebuggerUrl, expression, awaitPromise) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const timer = setTimeout(() => { socket.close(); resolve(undefined) }, 15000)
    socket.onopen = () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise, returnByValue: true },
      }))
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      const result = message.result?.result
      if (DEBUG) console.log('CDP 原始返回：', JSON.stringify(message.result).slice(0, 600))
      if (result?.value === undefined || result.value === null) {
        const detail = message.result?.exceptionDetails
        if (detail === undefined && result?.type === 'undefined') resolve(undefined)
        else reject(new Error(detail === undefined ? (result?.description ?? '探针没有返回可序列化的值') : `${detail.text} ${detail.exception?.description ?? ''}`.slice(0, 400)))
        return
      }
      if (typeof result.value === 'object' && result.value.error !== undefined && DEBUG) console.log('页面内的错误：', result.value.error)
      resolve(result.value)
    }
    socket.onerror = (event) => { clearTimeout(timer); reject(new Error(`WebSocket 出错：${event?.message ?? ''}`)) }
    socket.onclose = () => clearTimeout(timer)
  })
}

const measured = await runProbe('normal', PORT)
const emptyCase = await runProbe('no-repo', PORT + 1)
const mergeCase = await runProbe('merge', PORT + 2)
// `--repo` 才跑：用真实仓库（比如 D:\zxh\code\certbase-offline）的数据在真浏览器里量几何。
const realCase = REPO === null ? null : await runProbe('real', PORT + 3)

/* ------------------------------------------------------------------ 断言 */

const results = []
const ok = (label, problem) => results.push(problem === undefined ? `OK   ${label}` : `FAIL ${label}: ${problem}`)
const near = (left, right, tolerance) => Math.abs(left - right) <= tolerance

/**
 * 「同一个节点出来的线必须画在一起」：每个圆点上，所有止于该节点的线端（上下竖直段 +
 * 汇入/岔出斜线）离圆心的距离必须一致 —— 竖直段是 `calc(50% ± NODE_EDGE_PX)`、斜线是
 * 百分比换算，两者换算基准不一致时就会在圆环边上错开 1–2px（真机反馈 fc39963 那行）。
 */
const NODE_EDGE_PX = 4
function tipProblems(rows, laneBoxLeft, label) {
  const laneOf = (x) => Math.round((x - laneBoxLeft - LANE_GAP / 2) / LANE_GAP)
  const laneCenter = (lane) => laneBoxLeft + lane * LANE_GAP + LANE_GAP / 2
  const problems = []
  const checked = []
  let nodes = 0
  for (const row of rows) {
    if (row.dot === null) continue
    const nodeLane = laneOf(row.dot.left + row.dot.width / 2)
    const cy = row.dot.top + row.dot.height / 2
    const candidates = []
    for (const line of row.verticals) {
      if (near(line.left + line.width / 2, laneCenter(nodeLane), 1.5) === false) continue
      // 取靠近圆心的那一端（另一端在行边界上，是上一行/下一行的接缝）
      candidates.push(Math.abs(line.top - cy) <= Math.abs(line.bottom - cy) ? { who: '竖直段', y: line.top } : { who: '竖直段', y: line.bottom })
    }
    for (const line of row.diagonals) {
      const leftLane = laneOf(line.left + 1)
      const rightLane = laneOf(line.right - 1)
      if (leftLane !== nodeLane && rightLane !== nodeLane) continue
      // 斜线在节点泳道那一侧的端点是「最靠近圆心的那条 bbox 边」
      candidates.push(Math.abs(line.top - cy) <= Math.abs(line.bottom - cy) ? { who: '斜线', y: line.top } : { who: '斜线', y: line.bottom })
    }
    const incoming = candidates.filter((item) => item.y < cy)
    const outgoing = candidates.filter((item) => item.y >= cy)
    for (const [group, want] of [[incoming, cy - NODE_EDGE_PX], [outgoing, cy + NODE_EDGE_PX]]) {
      if (group.length < 2) continue
      nodes += 1
      checked.push(`${String(row.subject).slice(0, 20)}（${group.map((item) => `${item.who} ${item.y.toFixed(1)}`).join(' / ')}）`)
      const spread = Math.max(...group.map((item) => item.y)) - Math.min(...group.map((item) => item.y))
      const off = Math.max(...group.map((item) => Math.abs(item.y - want)))
      // 容差 0.75px：竖直段是 calc(50% ± 4px)、斜线带边界也是同一个 calc，理论上应当逐像素相等；
      // 老写法（斜线止点用 18% 近似）会差 1.3px，这里必须能红。
      if (spread > 0.75 || off > 0.75) {
        problems.push(`${label}「${String(row.subject).slice(0, 24)}」：${group.map((item) => `${item.who} ${item.y.toFixed(1)}`).join(' / ')}（圆心 ${cy.toFixed(1)}，期望 ${want.toFixed(1)}，错开 ${spread.toFixed(1)}px）`)
      }
    }
  }
  return { problems, nodes, checked }
}

if (measured.error !== undefined) {
  ok('页面探针执行', measured.error)
} else {
  const rows = measured.rows
  const rowOf = (subject) => rows.find((row) => row.subject === subject)
  const laneBoxLeft = rows.length === 0 ? 0 : rows[0].laneBox.left
  const center = (lane) => laneBoxLeft + lane * LANE_GAP + LANE_GAP / 2
  if (DEBUG) {
    for (const row of rows) {
      console.log(`  ${row.subject}: laneBox=${row.laneBox.left.toFixed(1)} 圆点=${row.dot === null ? 'n/a' : (row.dot.left + row.dot.width / 2).toFixed(1)} 竖线=[${row.verticals.map((line) => (line.left + line.width / 2).toFixed(1)).join(',')}] 斜线=[${row.diagonals.map((line) => `${line.left.toFixed(1)}~${line.right.toFixed(1)}`).join(',')}]`)
    }
  }
  ok(`渲染出 ${rows.length} 行提交`, rows.length === 8 ? undefined : `行数=${rows.length}（正文：${String(measured.bodyText).slice(0, 80)}）`)

  // 1. 斜线带必须由 calc(50% ± 4px) 精确量出上下边界（真机两个 bug：高度 auto 时按 viewBox
  //    固有比例算成 100px、斜线落到下面几行；止点用百分比近似导致与竖直段错开 1–2px）
  const badBand = []
  for (const row of rows) {
    if (row.bands.length === 0) continue
    const cy = row.dot === null ? row.row.top + row.row.height / 2 : row.dot.top + row.dot.height / 2
    for (const item of row.bands) {
      const above = item.box.top < cy
      const wantEdge = above ? cy - 4 : cy + 4
      const gotEdge = above ? item.box.bottom : item.box.top
      if (near(gotEdge, wantEdge, 1) === false) {
        badBand.push(`${row.subject}: ${above ? '上' : '下'}带${above ? '底' : '顶'}=${gotEdge.toFixed(1)}，期望圆心±4=${wantEdge.toFixed(1)}`)
      }
      if (near(item.box.width, row.laneBox.width, 0.5) === false) badBand.push(`${row.subject}: 带宽=${item.box.width.toFixed(1)}，期望 ${row.laneBox.width.toFixed(1)}`)
      if (item.lines.length === 0) badBand.push(`${row.subject}: 空斜线带`)
    }
    if (row.bands.length > 2) badBand.push(`${row.subject}: 斜线带 ${row.bands.length} 条（最多 2 条）`)
  }
  ok('斜线带边界精确落在「圆心 ± 4px」与行高上（不是百分比近似）', badBand.length === 0 ? undefined : badBand.slice(0, 4).join('；'))

  // 2. 圆点与所有连线都必须正落在某条泳道的中线上（真机 bug：连线以泳道中心为 left、
  //    但线宽 2px，线心比圆心偏右 1px）
  const offLane = []
  const laneOf = (x) => Math.round((x - laneBoxLeft - LANE_GAP / 2) / LANE_GAP)
  const laneCenter = (x) => laneBoxLeft + laneOf(x) * LANE_GAP + LANE_GAP / 2
  for (const row of rows) {
    if (row.dot !== null) {
      const dotX = row.dot.left + row.dot.width / 2
      if (near(dotX, laneCenter(dotX), 0.6) === false) offLane.push(`${row.subject}: 圆心 x=${dotX.toFixed(1)} 不在泳道中线上`)
    }
    for (const line of row.verticals) {
      if (near(line.width, 2, 0.2) === false) continue
      const lineX = line.left + line.width / 2
      if (near(lineX, laneCenter(lineX), 0.6) === false) offLane.push(`${row.subject}: 连线心 x=${lineX.toFixed(1)}，泳道中线 ${laneCenter(lineX).toFixed(1)}（偏 ${(lineX - laneCenter(lineX)).toFixed(1)}px）`)
    }
  }
  ok('圆点与连线都正落在泳道中线上（不再整体偏右 1px）', offLane.length === 0 ? undefined : offLane.slice(0, 4).join('；'))

  // 2b. 同一个节点出来的线必须止于同一高度（竖直段与斜线的换算基准要对齐）
  const tips = tipProblems(rows, laneBoxLeft, '')
  if (DEBUG) console.log(`  线端对齐检查覆盖了 ${tips.nodes} 个「多条线汇入/岔出」的节点`)
  ok('同一节点出来的线端落在同一高度（竖直段与斜线不错开）', tips.problems.length === 0 ? undefined : tips.problems.slice(0, 3).join('；'))

  // 3. 分支 tip：圆点独占泳道、上方不画线
  for (const [subject, lane] of [['test tip', 0], ['main tip', 1]]) {
    const row = rowOf(subject)
    if (row === undefined) { ok(`${subject}：泳道 ${lane} 且上方不画线`, '没有这一行'); continue }
    const dotX = row.dot === null ? -99 : row.dot.left + row.dot.width / 2
    const above = row.verticals.filter((line) => near(line.top, row.row.top, 1.5) && near(line.left + line.width / 2, center(lane), 1.5))
    ok(`${subject}：泳道 ${lane} 且上方不画线`, near(dotX, center(lane), 1) === false
      ? `圆点 x=${dotX.toFixed(1)}，期望 ${center(lane).toFixed(1)}`
      : (above.length === 0 ? undefined : 'tip 上方还画了连线'))
  }

  // 4. 汇入斜线：整条「上带」铺满（行顶(-1px) → 圆心-4px），两端落在两条泳道中心
  const fork = rowOf('fork commit')
  if (fork === undefined || fork.diagonals.length === 0) {
    ok('分叉斜线几何', '分叉行没有斜线')
  } else {
    const line = fork.diagonals[0]
    const cy = fork.dot.top + fork.dot.height / 2
    const problems = []
    if (near(line.top, fork.row.top, 1.5) === false) problems.push(`起点 y=${line.top.toFixed(1)}，期望行顶 ${fork.row.top.toFixed(1)}`)
    if (near(line.bottom, cy - 4, 1) === false) problems.push(`终点 y=${line.bottom.toFixed(1)}，期望圆心-4px=${(cy - 4).toFixed(1)}`)
    if (near(line.right, center(1) + 1, 2) === false) problems.push(`右端 x=${line.right.toFixed(1)}，期望 ${(center(1) + 1).toFixed(1)}`)
    if (near(line.left, center(0) - 1, 2) === false) problems.push(`左端 x=${line.left.toFixed(1)}，期望 ${(center(0) - 1).toFixed(1)}`)
    ok('汇入斜线铺满上带、两端落在两条泳道中心、止于圆心 ±4px', problems.length === 0 ? undefined : problems.join('；'))
  }

  // 5. 岔出斜线：整条「下带」铺满（圆心+4px → 行底(+1px)）
  const merge = rowOf('merge commit')
  if (merge === undefined || merge.diagonals.length === 0) {
    ok('分出斜线几何', '合并行没有斜线')
  } else {
    const line = merge.diagonals[0]
    const cy = merge.dot.top + merge.dot.height / 2
    const problems = []
    if (near(line.top, cy + 4, 1) === false) problems.push(`起点 y=${line.top.toFixed(1)}，期望圆心+4px=${(cy + 4).toFixed(1)}`)
    if (near(line.bottom, merge.row.bottom, 1.5) === false) problems.push(`终点 y=${line.bottom.toFixed(1)}，期望行底 ${merge.row.bottom.toFixed(1)}`)
    ok('岔出斜线铺满下带、起于圆心 ±4px 落到行底', problems.length === 0 ? undefined : problems.join('；'))
  }
}

/* ---------------------------------------- 未初始化仓库的空态（issue #2 的硬要求）
 * 要求：非仓库时**不显示任何功能内容**（页签 / 提交树 / 工具栏都不出现），只有一块居中的
 * 提示 + 一个按钮；点下去初始化成功后，功能面板要自己长回来。
 */
if (emptyCase.error !== undefined) {
  ok('未初始化仓库：空态探针执行', emptyCase.error)
} else {
  const before = emptyCase.before
  const after = emptyCase.after
  const FEATURES = ['Local Changes', 'Log', 'Console', 'Branches', 'Remotes', 'Stash']
  const leaked = before.tabs.filter((text) => FEATURES.includes(text) || text === 'Refresh' || text === 'Push')
  ok('非仓库时不渲染任何功能内容（页签 / 工具栏都不在）', leaked.length === 0 ? undefined : `仍然渲染了：${leaked.join('、')}`)
  ok('非仓库时提交树一行都不渲染', before.graphRows === 0 ? undefined : `提交树出现 ${before.graphRows} 行`)
  ok('空态里有仓库路径提示', before.emptyText.includes('不是 Git 仓库') && before.emptyText.includes('D:/fixture')
    ? undefined
    : `空态文案=${JSON.stringify(before.emptyText.slice(0, 120))}`)
  ok('空态里只有一行说明 + 一个按钮（没有多余长文案）',
    before.emptyButtons === 1 && before.initBox !== null
      ? (before.emptyText.length <= 60 ? undefined : `空态文案太长（${before.emptyText.length} 字）：${JSON.stringify(before.emptyText.slice(0, 120))}`)
      : `按钮数=${before.emptyButtons}`)

  // 铺满：空态块必须横向占满面板、纵向吃掉路径栏以下的全部空间（flex:1 掉了就会缩成左上角一条）。
  if (before.emptyBox === null || before.pathBarBox === null) {
    ok('空态块铺满路径栏以下的全部空间', '没找到空态块 / 路径栏')
  } else {
    const panel = before.panelBox
    const area = before.emptyBox
    const problems = []
    if (Math.abs(area.left - panel.left) > 2 || Math.abs(area.right - panel.right) > 2) {
      problems.push(`横向没铺满（块 ${area.left.toFixed(1)}~${area.right.toFixed(1)}，面板 ${panel.left.toFixed(1)}~${panel.right.toFixed(1)}）`)
    }
    if (Math.abs(area.top - before.pathBarBox.bottom) > 2) problems.push(`顶边 ${area.top.toFixed(1)}，期望贴着路径栏底 ${before.pathBarBox.bottom.toFixed(1)}`)
    if (Math.abs(area.bottom - panel.bottom) > 2) problems.push(`底边 ${area.bottom.toFixed(1)}，期望面板底 ${panel.bottom.toFixed(1)}`)
    ok('空态块铺满路径栏以下的全部空间（内容在其中居中）', problems.length === 0 ? undefined : problems.join('；'))
    // 按钮自己也必须在空态块的水平中线上
    if (before.initBox !== null) {
      const bx = (before.initBox.left + before.initBox.right) / 2 - (area.left + area.right) / 2
      ok('初始化按钮与提示同一中轴', Math.abs(bx) <= 2 ? undefined : `按钮偏 ${bx.toFixed(1)}px`)
    }
  }

  // 分支名选择：点第一下只展开表单，不能已经发了 repo/init；备选 main/master 要能改输入框的值。
  const chooser = emptyCase.chooser
  ok('点按钮先展开分支名选择（此时还没发 repo/init）',
    chooser.shown === true && chooser.initCallsAfterOpen === 0
      ? undefined
      : `表单出现=${chooser.shown}、此时调用次数=${chooser.initCallsAfterOpen}`)
  ok('分支名默认 main，且备选里有 main / master',
    chooser.branchValue === 'main' && chooser.chips.includes('main') && chooser.chips.includes('master')
      ? undefined
      : `默认值=${JSON.stringify(chooser.branchValue)}、按钮=${JSON.stringify(chooser.chips)}`)
  ok('点 master 备选后输入框变成 master', chooser.valueAfterChip === 'master' ? undefined : `输入框=${JSON.stringify(chooser.valueAfterChip)}`)

  ok('确认后才调用 repo/init，且分支名随用户选择带上', after.initCalls === 1 && after.initPayload?.branch === 'master'
    ? undefined
    : `调用次数=${after.initCalls}、payload=${JSON.stringify(after.initPayload)}`)
  ok('初始化成功后空态消失、功能面板自己长回来', after.emptyGone === true && before.emptyButtons === 1
    && FEATURES.every((text) => after.tabs.includes(text)) && after.tabs.includes('Refresh')
    ? undefined
    : `点之前空态按钮数=${before.emptyButtons}、点之后空态消失=${after.emptyGone}，页签=${JSON.stringify(after.tabs)}`)
}

/* ---------------------------------------- 合并线 / 标签截断 / 详情分支清单（mode = merge）
 * 这一组钉死三件事：
 *   1. 合并的第二父提交若已被别的泳道期待，就并进那条泳道 —— 不许向右岔出再折回；
 *   2. 画面上不许出现"一个节点都没有"的泳道（用户报的"没有开始的分支线"）；
 *   3. 提交树列宽度受标签截断（≤ LABEL_MAX_PX）+ 每行最多 3 个标签约束，
 *      完整分支清单在点开提交后的详情里。
 */
const LABEL_MAX_PX = 96
const LABEL_MAX_CHIPS = 3
if (mergeCase.error !== undefined) {
  ok('合并线回归探针执行', mergeCase.error)
} else {
  const rows = mergeCase.rows
  const rowOf = (subject) => rows.find((row) => row.subject === subject)
  const laneBoxLeft = rows.length === 0 ? 0 : rows[0].laneBox.left
  const center = (lane) => laneBoxLeft + lane * LANE_GAP + LANE_GAP / 2
  const laneOf = (x) => Math.round((x - laneBoxLeft - LANE_GAP / 2) / LANE_GAP)
  if (DEBUG) {
    for (const row of rows) {
      console.log(`  [merge] ${row.subject}: 圆点泳道=${row.dot === null ? 'n/a' : laneOf(row.dot.left + row.dot.width / 2)} 竖线泳道=[${row.verticals.map((line) => laneOf(line.left + line.width / 2)).join(',')}] 斜线=[${row.diagonals.map((line) => `${laneOf(line.left + 1)}→${laneOf(line.right - 1)}`).join(',')}] 单元宽=${row.cell === null ? 'n/a' : row.cell.width.toFixed(1)}`)
    }
  }
  ok(`合并夹具渲染出 ${rows.length} 行提交`, rows.length === 6 ? undefined : `行数=${rows.length}`)

  const merge = rowOf('merge cust into main')
  const below = rowOf('main below merge')
  if (merge === undefined || below === undefined) {
    ok('合并行 / 主干行都在', '缺行')
  } else {
    // 1. 合并行只有一条斜线，且是**向左**并进主干泳道（lane 1 → lane 0）；不许出现 lane 2
    const line = merge.diagonals.length === 1 ? merge.diagonals[0] : null
    const problems = []
    if (line === null) problems.push(`斜线数=${merge.diagonals.length}（期望 1）`)
    else {
      if (near(line.left, center(0) - 1, 2) === false) problems.push(`左端 x=${line.left.toFixed(1)}，期望主干泳道中心 ${(center(0) - 1).toFixed(1)}`)
      if (near(line.right, center(1) + 1, 2) === false) problems.push(`右端 x=${line.right.toFixed(1)}，期望客户泳道中心 ${(center(1) + 1).toFixed(1)}`)
    }
    ok('合并线直接并进主干泳道（不向右突出再折返）', problems.length === 0 ? undefined : problems.join('；'))

    // 主干行不该再有汇合斜线（旧算法在这里把 lane 2 折回来）
    ok('主干行没有多余的汇合斜线', below.diagonals.length === 0
      ? undefined
      : `斜线数=${below.diagonals.length}`)

    // 2. 泳道数 = 2（旧算法会多出一条 lane 2），且不许有无节点的泳道
    const dotLanes = new Set(rows.filter((row) => row.dot !== null).map((row) => laneOf(row.dot.left + row.dot.width / 2)))
    const lineLanes = new Set()
    for (const row of rows) {
      for (const seg of row.verticals) lineLanes.add(laneOf(seg.left + seg.width / 2))
      for (const seg of row.diagonals) { lineLanes.add(laneOf(seg.left + 1)); lineLanes.add(laneOf(seg.right - 1)) }
    }
    const floating = [...lineLanes].filter((lane) => dotLanes.has(lane) === false)
    ok('提交树只有 2 条泳道（合并不再多开一条）',
      rows[0].laneBox.width === 2 * LANE_GAP ? undefined : `泳道区宽=${rows[0].laneBox.width}px，期望 ${2 * LANE_GAP}px`)
    ok('没有"一个节点都没有"的泳道', floating.length === 0 ? undefined : `无节点泳道=${floating.join(',')}`)

    // 2b. 已经取全时，末行不该再有指向窗口外的断头线（浅克隆 / 渲染到上限）
    const lastRow = rows[rows.length - 1]
    const dangling = lastRow.verticals.filter((line) => line.bottom > lastRow.row.bottom - 5)
    ok('末行没有指向窗口外的断头线', dangling.length === 0
      ? undefined
      : `${dangling.length} 条线画到了行底（行底 ${lastRow.row.bottom.toFixed(1)}）`)

    // 3. 分支标签：一行最多 3 个 + `+N`，单个不超过 LABEL_MAX_PX
    const cust = rowOf('cust tip')
    const chips = cust === undefined ? [] : cust.chips
    const names = chips.map((chip) => chip.text)
    ok(`一行最多 ${LABEL_MAX_CHIPS} 个标签，多出来折成 +N`,
      chips.length === LABEL_MAX_CHIPS + 1 && names[LABEL_MAX_CHIPS] === `+${4 - LABEL_MAX_CHIPS}`
        ? undefined
        : `标签=${JSON.stringify(names)}`)
    const tooWide = chips.filter((chip) => chip.width > LABEL_MAX_PX + 2)
    ok(`单个分支标签不超过 ${LABEL_MAX_PX}px（省略号截断）`, tooWide.length === 0
      ? undefined
      : tooWide.map((chip) => `${chip.text}=${chip.width.toFixed(1)}px`).join('；'))
    const longName = 'origin/feature/a-very-long-branch-name'
    const withTitle = chips.find((chip) => chip.title.includes(longName))
    ok('截断的标签仍带完整分支名（title）', withTitle === undefined ? `没找到带 ${longName} 的标签` : undefined)
    ok('提交树列宽度受控（≤ 240px）', cust === undefined || cust.cell === null ? '没量到单元格' : (cust.cell.width <= 240 ? undefined : `列宽=${cust.cell.width.toFixed(1)}px`))

    // 4. 点开提交后，详情里能看到指向它的**全部分支**（完整名字）
    const branchRow = mergeCase.branchRow
    if (branchRow === null) {
      ok('提交详情里有「分支」一行', '没找到')
    } else {
      const texts = branchRow.chips.map((chip) => chip.text)
      ok('提交详情的「分支」一行列出全部分支（完整名字、不截断）',
        texts.length === 5 && texts[0] === '分支 · 4' && texts.includes(longName) && texts.includes('origin/customer/guizhou-bianjian')
          ? undefined
          : `内容=${JSON.stringify(texts)}`)
      const clipped = branchRow.chips.slice(1).filter((chip) => chip.text.includes('…'))
      ok('详情里的分支名不截断（没有省略号）', clipped.length === 0 ? undefined : JSON.stringify(clipped))
    }
  }
}

/* ---------------------------------------- 真实仓库（--repo）：同样的几何不变量
 * 合成夹具只覆盖一种拓扑；这里把用户实际那个仓库（certbase-offline）的提交树整个喂进来，
 * 逐行量：不许有"没有节点的泳道"、不许有"向右突出再折返"的尖角。
 */
if (realCase !== null) {
  if (realCase.error !== undefined) {
    ok(`真实仓库提交树（${REPO}）探针执行`, realCase.error)
  } else {
    const rows = realCase.rows
    const laneBoxLeft = rows.length === 0 ? 0 : rows[0].laneBox.left
    const laneOf = (x) => Math.round((x - laneBoxLeft - LANE_GAP / 2) / LANE_GAP)
    const dotLanes = new Set()
    const lineLanes = new Set()
    const outTo = new Map()
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (row.dot !== null) dotLanes.add(laneOf(row.dot.left + row.dot.width / 2))
      for (const seg of row.verticals) lineLanes.add(laneOf(seg.left + seg.width / 2))
      for (const seg of row.diagonals) {
        const from = laneOf(seg.left + 1)
        const to = laneOf(seg.right - 1)
        lineLanes.add(from)
        lineLanes.add(to)
        // 分出斜线：记下"本行向右岔到哪条泳道"，下一行若又折回来就是那个假尖角
        if (to > from) outTo.set(index, { lane: to, subject: row.subject })
      }
    }
    const floating = [...lineLanes].filter((lane) => dotLanes.has(lane) === false).sort((left, right) => left - right)
    ok(`真实仓库：${rows.length} 行提交都没有"没有节点的泳道"`, floating.length === 0 ? undefined : `无节点泳道=${floating.join(',')}`)
    const spikes = []
    for (const [index, out] of outTo) {
      const next = rows[index + 1]
      if (next === undefined) continue
      for (const seg of next.diagonals) {
        // 汇入斜线（in）：左上角是终点泳道、右下角是起点泳道
        const to = laneOf(seg.left + 1)
        const from = laneOf(seg.right - 1)
        if (from === out.lane && to < out.lane) spikes.push(`${out.subject} → ${next.subject}（泳道 ${out.lane}）`)
      }
    }
    ok('真实仓库：没有向右突出又折返的合并线',
      spikes.length === 0 ? undefined : `${spikes.length} 处：${spikes.slice(0, 3).join('；')}`)
    const wide = rows.filter((row) => row.cell !== null && row.cell.width > 240)
    ok('真实仓库：提交树列宽度 ≤ 240px', wide.length === 0 ? undefined : wide.slice(0, 2).map((row) => `${row.cell.width.toFixed(1)}px`).join('；'))
    const realTips = tipProblems(rows, laneBoxLeft, '真实仓库')
    if (DEBUG) {
      console.log(`  [real] 线端对齐检查覆盖了 ${realTips.nodes} 个「多条线汇入/岔出」的节点`)
      for (const item of realTips.checked) console.log(`    · ${item}`)
    }
    ok('真实仓库：同一节点出来的线端落在同一高度（且这种节点确实存在）',
      realTips.problems.length === 0 && realTips.nodes > 0
        ? undefined
        : (realTips.problems.length > 0 ? `${realTips.problems.length} 处：${realTips.problems.slice(0, 3).join('；')}` : '一个都没有覆盖到，断言可能是空跑'))
  }
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`)
process.exit(failed.length > 0 ? 1 : 0)
