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
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = join(ROOT, '.npm-cache', 'domprobe')
const CLIENT = join(ROOT, 'lib', 'client.js')
const PORT = Number(process.env.DOM_PROBE_PORT ?? 9337)
const DEBUG = process.argv.includes('--debug')

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
const call = async () => ({ ok: true, value })
`

const pageScript = `
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
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
await wait(600)
const logTab = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Log')
if (logTab === undefined) return { error: '没找到 Log 页签按钮' }
logTab.click()
await wait(400)

const rect = (node) => {
  const box = node.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }
}
const rows = []
for (const row of document.querySelectorAll('div[title]')) {
  // 提交行的标志：行样式带 cursor: pointer **且**含 12px 的圆点 SVG
  //（提交树单元格自己也有 title，分支标签、工具栏按钮也会被 div[title] 捞到，都要排掉）
  if ((row.getAttribute('style') ?? '').includes('cursor: pointer') === false) continue
  if (row.querySelector('svg[width="12"]') === null) continue
  const laneBox = row.querySelector('div[style*="position: relative"]')
  const svgs = [...row.querySelectorAll('svg')]
  const linesSvg = svgs.find((node) => (node.getAttribute('viewBox') ?? '').split(' ')[3] === '100')
  const dotSvg = svgs.find((node) => node.getAttribute('width') === '12')
  rows.push({
    subject: row.getAttribute('title'),
    row: rect(row),
    laneBox: rect(laneBox),
    linesSvg: linesSvg === undefined ? null : rect(linesSvg),
    dot: dotSvg === undefined ? null : rect(dotSvg),
    verticals: [...row.querySelectorAll('div')]
      .filter((node) => (node.getAttribute('style') ?? '').includes('width: 2px'))
      .map((node) => rect(node)),
    diagonals: linesSvg === undefined ? [] : [...linesSvg.querySelectorAll('line')].map((line) => rect(line)),
  })
}
return { rows, bodyText: document.body.innerText.slice(0, 200) }
`

/* ------------------------------------------------------------------ 页面 + 浏览器 */

mkdirSync(SCRATCH, { recursive: true })
const pagePath = join(SCRATCH, 'harness.html')
writeFileSync(pagePath, [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<style>html,body{margin:0;padding:0;font:12px/1.5 sans-serif;background:#fff} #root{width:760px}</style>',
  '</head><body><div id="root"></div>',
  '<script>window.__ModuleLoader__ = { load: (spec) => { window.__entry = spec } }</script>',
  `<script>${readFileSync(react, 'utf8')}</script>`,
  `<script>${readFileSync(reactDom, 'utf8')}</script>`,
  `<script>${readFileSync(CLIENT, 'utf8')}</script>`,
  `<script>${fixture}</script>`,
  `<script>window.__probe = (async () => { try { ${pageScript} } catch (cause) { return { error: String((cause && cause.stack) || cause) } } })()</script>`,
  '</body></html>',
].join('\n'), 'utf8')

const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(SCRATCH, 'profile')}`,
  `file:///${pagePath.replace(/\\/g, '/')}`,
], { stdio: 'ignore', windowsHide: true })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 等页面里的探针 promise 出结果；期间轮询 CDP 的页面 target。 */
async function readProbe() {
  let lastError = 'CDP 没有响应'
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json())
      const target = list.find((item) => item.type === 'page' && String(item.url).includes('harness.html'))
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

let measured = { error: '没有跑起来' }
try {
  measured = await readProbe()
} finally {
  child.kill()
}

/* ------------------------------------------------------------------ 断言 */

const results = []
const ok = (label, problem) => results.push(problem === undefined ? `OK   ${label}` : `FAIL ${label}: ${problem}`)
const near = (left, right, tolerance) => Math.abs(left - right) <= tolerance

if (measured.error !== undefined) {
  ok('页面探针执行', measured.error)
} else {
  const rows = measured.rows
  const rowOf = (subject) => rows.find((row) => row.subject === subject)
  const laneBoxLeft = rows.length === 0 ? 0 : rows[0].laneBox.left
  const center = (lane) => laneBoxLeft + lane * LANE_GAP + LANE_GAP / 2
  ok(`渲染出 ${rows.length} 行提交`, rows.length === 8 ? undefined : `行数=${rows.length}（正文：${String(measured.bodyText).slice(0, 80)}）`)

  // 1. 斜线层高度必须等于行高（真机 bug：高度 auto → 按 viewBox 比例算成 100px，斜线落到下面几行）
  const badHeight = rows.filter((row) => row.linesSvg === null || near(row.linesSvg.height, row.laneBox.height, 1) === false)
  ok('斜线 SVG 的高度等于行高（不是 viewBox 固有比例算出的 100px）', badHeight.length === 0
    ? undefined
    : badHeight.map((row) => `${row.subject}: svg=${row.linesSvg === null ? 'n/a' : row.linesSvg.height.toFixed(1)} 行=${row.laneBox.height.toFixed(1)}`).join('；'))

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

  // 4. 分叉斜线：只占分叉行上半段的 0→32%，两端落在两条泳道中心
  const fork = rowOf('fork commit')
  if (fork === undefined || fork.diagonals.length === 0) {
    ok('分叉斜线几何', '分叉行没有斜线')
  } else {
    const line = fork.diagonals[0]
    const expectedBottom = fork.row.top + 0.32 * fork.row.height
    const problems = []
    if (near(line.top, fork.row.top, 2) === false) problems.push(`起点 y=${line.top.toFixed(1)}，期望行顶 ${fork.row.top.toFixed(1)}`)
    if (near(line.bottom, expectedBottom, 2.5) === false) problems.push(`终点 y=${line.bottom.toFixed(1)}，期望 ${expectedBottom.toFixed(1)}（行的 32%）`)
    if (near(line.right, center(1) + 1, 2) === false) problems.push(`右端 x=${line.right.toFixed(1)}，期望 ${(center(1) + 1).toFixed(1)}`)
    if (near(line.left, center(0) - 1, 2) === false) problems.push(`左端 x=${line.left.toFixed(1)}，期望 ${(center(0) - 1).toFixed(1)}`)
    ok('分叉斜线只占分叉行上半段、两端落在两条泳道中心', problems.length === 0 ? undefined : problems.join('；'))
  }

  // 5. 分出斜线：从 68% 到行底
  const merge = rowOf('merge commit')
  if (merge === undefined || merge.diagonals.length === 0) {
    ok('分出斜线几何', '合并行没有斜线')
  } else {
    const line = merge.diagonals[0]
    const expectedTop = merge.row.top + 0.68 * merge.row.height
    const problems = []
    if (near(line.top, expectedTop, 2.5) === false) problems.push(`起点 y=${line.top.toFixed(1)}，期望 ${expectedTop.toFixed(1)}（行的 68%）`)
    if (near(line.bottom, merge.row.bottom, 2.5) === false) problems.push(`终点 y=${line.bottom.toFixed(1)}，期望行底 ${merge.row.bottom.toFixed(1)}`)
    ok('分出斜线从行下半段起始、落到行底', problems.length === 0 ? undefined : problems.join('；'))
  }
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`)
process.exit(failed.length > 0 ? 1 : 0)
