/**
 * 浏览器半区自检：本机零依赖（没有装 react），所以这里用一个 ~120 行的迷你 React（createElement /
 * useState / useEffect / useRef）把 GitBody 真挂起来跑一遍「打开仓库 → 快照 → 切 Log → 滚到底续拉 → 刷新」，
 * 断言提交树覆盖所有分支、续拉不重复、刷新不缩水。
 *
 * 用法：node scripts/render-probe.mjs
 *
 * 为什么值得写：lib/client.js 是零构建产物，没有任何自动化覆盖；提交树的分页/hover 缓存这类改动
 * 只能靠人手点。这个探针把关键的「数据流转」钉死，视觉部分仍需在真机上目测。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ 迷你 React */

const instances = new Map()
let current = null
let dirty = false
let effects = []

function createElement(type, props, ...children) {
  const kids = []
  const push = (child) => {
    if (child === null || child === undefined || typeof child === 'boolean') return
    if (Array.isArray(child)) { child.forEach(push); return }
    kids.push(child)
  }
  children.forEach(push)
  return { type, props: { ...(props === null || props === undefined ? {} : props), children: kids } }
}

function instanceAt(path) {
  let inst = instances.get(path)
  if (inst === undefined) {
    inst = { hooks: [], index: 0 }
    instances.set(path, inst)
  }
  return inst
}

function useState(initial) {
  const inst = current
  const slot = inst.index++
  if (inst.hooks[slot] === undefined) inst.hooks[slot] = { value: typeof initial === 'function' ? initial() : initial }
  const cell = inst.hooks[slot]
  const set = (next) => {
    const value = typeof next === 'function' ? next(cell.value) : next
    if (Object.is(value, cell.value)) return
    cell.value = value
    dirty = true
  }
  return [cell.value, set]
}

function useRef(initial) {
  const inst = current
  const slot = inst.index++
  if (inst.hooks[slot] === undefined) inst.hooks[slot] = { ref: { current: initial } }
  return inst.hooks[slot].ref
}

function useEffect(fn, deps) {
  const inst = current
  const slot = inst.index++
  if (inst.hooks[slot] === undefined) inst.hooks[slot] = {}
  const cell = inst.hooks[slot]
  const prev = cell.deps
  const changed = deps === undefined || prev === undefined || prev.length !== deps.length
    || deps.some((dep, index) => Object.is(dep, prev[index]) === false)
  if (changed) {
    cell.deps = deps === undefined ? undefined : [...deps]
    effects.push({ cell, fn })
  }
}

const React = { createElement, useState, useEffect, useRef }
const h = createElement

/** 渲染一个节点树：函数组件就地展开，宿主元素保留 props/children 供断言遍历。 */
function renderNode(vnode, path) {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return vnode
  if (Array.isArray(vnode)) return vnode.map((child, index) => renderNode(child, `${path}.${index}`))
  if (typeof vnode.type === 'function') {
    const inst = instanceAt(path)
    const saved = current
    current = inst
    inst.index = 0
    let produced
    try {
      produced = vnode.type(vnode.props)
    } finally {
      current = saved
    }
    return renderNode(produced, path)
  }
  return {
    type: vnode.type,
    props: vnode.props,
    children: (vnode.props.children ?? []).map((child, index) => renderNode(child, `${path}.${index}`)),
  }
}

const tick = () => new Promise((done) => setImmediate(done))

/** 渲染到稳定：每轮跑完 effect 后等一次宏任务，直到没有状态变更（异步 RPC 的 setState 也能落地）。 */
async function settle(render) {
  let tree = null
  for (let pass = 0; pass < 30; pass++) {
    dirty = false
    effects = []
    tree = renderNode(render(), 'root')
    await tick()
    let ran = 0
    while (effects.length > 0) {
      const job = effects.shift()
      if (typeof job.cell.cleanup === 'function') job.cell.cleanup()
      const cleanup = job.fn()
      job.cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      ran += 1
      if (ran > 200) throw new Error('effect 数量异常，疑似死循环')
    }
    await tick()
    if (dirty !== true) return tree
  }
  throw new Error('渲染未收敛：effect 在无限改状态？')
}

/* -------------------------------------------------------------- 断言小工具 */

function walk(node, visit) {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (node === null || typeof node !== 'object') return
  visit(node)
  ;(node.children ?? []).forEach((child) => walk(child, visit))
}

function texts(node) {
  const out = []
  walk(node, (item) => {
    for (const child of item.children ?? []) if (typeof child === 'string') out.push(child)
  })
  return out
}

const find = (tree, predicate) => {
  let hit = null
  walk(tree, (node) => { if (hit === null && predicate(node) === true) hit = node })
  return hit
}
const findAll = (tree, predicate) => {
  const hits = []
  walk(tree, (node) => { if (predicate(node) === true) hits.push(node) })
  return hits
}
const findButton = (tree, label) => find(tree, (node) => node.type === 'button' && texts(node).includes(label))
/** 提交行：带 onContextMenu 的 div（右键菜单是提交行独有的）。 */
const commitRows = (tree) => findAll(tree, (node) => typeof node.props?.onContextMenu === 'function')

/** 泳道常量（与 lib/client.js 的 LANE_GAP / NODE_EDGE_PCT 对应）。 */
const LANE_GAP = 14
const center = (lane) => lane * LANE_GAP + LANE_GAP / 2
const NODE_EDGE_PCT = 18

/** 取某条提交行的「提交树」单元格（tdGraph 是那个 display:flex + gap:4px 的盒子）。 */
function graphCellOf(tree, subject) {
  const row = find(tree, (node) => node.props?.title === subject && typeof node.props?.onContextMenu === 'function')
  if (row === null) return null
  return find(row, (node) => node.props?.style?.display === 'flex' && node.props?.style?.gap === '4px')
}
/** 单元格里的竖直连线段（div：position absolute + width 2px）。 */
const verticalSegs = (cell) => findAll(cell, (node) => node.props?.style?.position === 'absolute' && node.props?.style?.width === '2px')
/** 单元格里的斜线（svg line）。 */
const diagonalSegs = (cell) => findAll(cell, (node) => node.props?.x1 !== undefined && node.props?.y1 !== undefined)
/** 单元格里的圆点（12×12 的 svg）。 */
const nodeDot = (cell) => find(cell, (node) => node.props?.width === 12 && node.props?.height === 12 && typeof node.props?.style?.left === 'string')
/**
 * 竖线段是否落在第 lane 条泳道的中线上。
 * 线宽 2px，`left` 是**左边缘**（= 泳道中心 - 1），所以要 +1 还原成线心再比。
 */
const atLane = (node, lane) => Math.abs(parseFloat(node.props.style.left) + 1 - center(lane)) < 0.01
/** 圆点的左边缘（= 泳道中心 - 6，12px 画布里的圆以 cx=6 居中）。 */
const dotAtLane = (node, lane) => Math.abs(parseFloat(node.props.style.left) - (center(lane) - 6)) < 0.01

/* ------------------------------------------------------------------ 夹具数据 */

const SNAPSHOT = 50
const TOTAL = 55
/**
 * 拓扑刻意照抄真机那个仓库（就是用户反馈画错的那张图）：
 *   第 0 行 = test 分支 tip（新分支上最新的一条），第 1 行 = 它上一条，
 *   第 2 行 = main tip（HEAD），第 3..5 行是 main 上更早的提交，
 *   第 6 行 = **分叉提交**（test 分支的父提交 = main 第 5 行的父提交），之后一条直线。
 * 也就是说 test 分支分叉在 6 条提交之前，绝不能画成"从 main 最新提交长出来"。
 */
const FORK = 6
const mkHash = (index) => `${String(index).padStart(2, '0')}f`.repeat(20)
const parentsOf = (index) => {
  if (index === 0) return [mkHash(1)]
  if (index === 1) return [mkHash(FORK)]
  return index < TOTAL - 1 ? [mkHash(index + 1)] : []
}
const mkCommit = (index) => ({
  hash: mkHash(index),
  shortHash: mkHash(index).slice(0, 7),
  author: 'verify',
  email: 'verify@test',
  date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  parents: parentsOf(index),
  subject: index === 0 ? 'feature/x 独有的提交' : `提交 ${index}`,
  body: '',
})

const COMMITS = Array.from({ length: TOTAL }, (_, index) => mkCommit(index))
/** 不带 all 的 `git log` 只走 HEAD 的祖先链，拿不到 test 分支那两条 —— 夹具照这个语义给数据。 */
const reachable = (all) => (all === true ? COMMITS : COMMITS.slice(2))
const calls = []
/** `--real` 模式下换成真实仓库的数据源（见文件末尾的对照检查）。 */
let realSource = null
const payloadOf = (endpoint) => {
  const hit = [...calls].reverse().find((row) => row.endpoint === endpoint)
  return hit === undefined ? null : hit.payload
}

async function fakeCall(channel, endpoint, payload) {
  calls.push({ endpoint, payload })
  if (realSource !== null && endpoint === 'repo/snapshot') return realSource(payload)
  if (realSource !== null && endpoint === 'log') return { ok: true, value: { commits: [] } }
  if (endpoint === 'repo/snapshot') {
    const limit = Math.min(payload.limit ?? SNAPSHOT, TOTAL)
    const visible = reachable(payload.all)
    const main = COMMITS[2]
    const feature = COMMITS[0]
    return { ok: true, value: {
      repo: {
        cwd: 'D:/fixture', root: 'D:/fixture', branch: 'main', detached: false,
        shortHead: main.shortHash, oid: main.hash, upstream: 'origin/main',
        ahead: 0, behind: 0, remoteUrl: 'https://example.com/fixture.git', gitVersion: 'git version 2.49.0',
      },
      config: { allowWrite: true, allowPush: true, allowDangerous: true, diffContextLines: 3, autoRefreshSeconds: 0 },
      status: { branch: { oid: main.hash, head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false }, entries: [] },
      commits: visible.slice(0, limit),
      branches: {
        local: [
          { ref: 'refs/heads/main', name: 'main', shortHash: main.shortHash, hash: main.hash, kind: 'local', upstream: 'origin/main', ahead: 0, behind: 0, date: main.date, subject: main.subject },
          { ref: 'refs/heads/feature/x', name: 'feature/x', shortHash: feature.shortHash, hash: feature.hash, kind: 'local', upstream: '', ahead: 0, behind: 0, date: feature.date, subject: feature.subject },
        ],
        remote: [],
      },
      stashes: [],
      console: [],
    } }
  }
  if (endpoint === 'log') {
    const skip = payload.skip ?? 0
    const visible = reachable(payload.all)
    // 故意与上一页重叠一条（模拟两次调用之间落了新提交）：客户端必须按 hash 去重。
    const from = Math.max(0, skip - 1)
    return { ok: true, value: { commits: visible.slice(from, skip + SNAPSHOT) } }
  }
  return { ok: false, error: { code: 'git-vcs/unknown-endpoint', message: `探针没有实现 ${endpoint}`, details: {} } }
}

/* ------------------------------------------------------------------ 装载半区 */

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
// 转圈图标靠 rAF 每帧改 state 做动画；探针里把它变成空操作，否则渲染永远不收敛。
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
await import(pathToFileURL(join(ROOT, 'lib', 'client.js')).href)
if (loaded === null || loaded.id !== 'dsh-git-vcs') throw new Error('client.js 没有通过 __ModuleLoader__ 注册')

const half = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`客户端半区 require 了未提供的模块：${specifier}`)
})

let GitBody = null
let face = null
half.apply({
  effect(fn) { fn() },
  sidebarRightTabs: { register: () => () => {} },
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      if (spec.name === 'sidebar.right.pane.tab') { GitBody = component; face = spec.inject }
      return () => {}
    },
  },
  connection: { rpc: { call: fakeCall } },
})
if (GitBody === null) throw new Error('客户端半区没有注册 sidebar.right.pane.tab 正文')

const render = () => h(GitBody, {
  ...face(),
  // 真机里这是会话工作目录的 selector hook；探针直接给出仓库路径，让面板自动打开。
  useSessions: () => ({ current: 's1', byId: { s1: { cwd: 'D:/fixture' } } }),
})

/* ------------------------------------------------------------------ 开始断言 */

const results = []
const ok = (label, problem) => results.push(problem === undefined ? `OK   ${label}` : `FAIL ${label}: ${problem}`)

let tree = await settle(render)

ok('打开仓库后的首屏请求带 all=true（提交树覆盖所有分支）', (() => {
  const payload = payloadOf('repo/snapshot')
  if (payload === null) return '没有发出 repo/snapshot'
  if (payload.all !== true) return `all=${JSON.stringify(payload.all)}`
  return payload.limit === SNAPSHOT ? undefined : `首屏 limit=${payload.limit}`
})())

const logTab = findButton(tree, 'Log')
if (logTab === null) {
  ok('切到 Log 页签', '没找到 Log 页签按钮')
} else {
  logTab.props.onClick()
  tree = await settle(render)

  const rows = commitRows(tree)
  ok('首屏提交树行数等于 limit', rows.length === SNAPSHOT ? undefined : `行数=${rows.length}`)

  const featureRow = find(tree, (node) => node.props?.title === 'feature/x 独有的提交')
  ok('提交树里出现其它分支独有的提交（issue #1 的核心）', featureRow === undefined || featureRow === null ? '没有渲染出 feature/x 的提交行' : undefined)
  ok('该行挂上了 feature/x 分支标签', featureRow === null ? '行不存在' : (texts(featureRow).includes('feature/x') ? undefined : `标签=${texts(featureRow).join('|')}`))

  /* ---------------------------------------------- 泳道拓扑（用户实拍的那张错图）
   * 夹具：0/1 = test 分支两条（1 的父提交是 6），2 = main tip，3..5 = main 更早的提交，
   * 6 = 分叉提交（1 与 5 的父提交都是它）。也就是说 test 分支分叉在 5 条提交之前。
   * 旧画法把 test 的两条画在 main 那条线的正上方（看着像从 main tip 长出来的），这里逐条钉死几何。
   */
  const featureCell = graphCellOf(tree, 'feature/x 独有的提交')
  const mainCell = graphCellOf(tree, '提交 2')
  const forkCell = graphCellOf(tree, '提交 6')
  const beforeForkCell = graphCellOf(tree, '提交 5')
  const afterForkCell = graphCellOf(tree, '提交 7')

  ok('test 分支的 tip 独占最左泳道，且上方不画线（它是分支起点，不是 main 的延续）', (() => {
    if (featureCell === null) return '没找到该行的提交树单元格'
    const dot = nodeDot(featureCell)
    if (dot === null) return '没找到圆点'
    if (dotAtLane(dot, 0) === false) return `圆点 left=${dot.props.style.left}，期望 ${center(0) - 6}px`
    const up = verticalSegs(featureCell).find((node) => atLane(node, 0) && node.props.style.top === '-1px')
    return up === undefined ? undefined : '分支 tip 上方还画了连线'
  })())

  ok('main 的 tip 落在**另一条**泳道（第二条），不是接着 test 那条线', (() => {
    if (mainCell === null) return '没找到该行的提交树单元格'
    const dot = nodeDot(mainCell)
    if (dot === null) return '没找到圆点'
    if (dotAtLane(dot, 1) === false) return `圆点 left=${dot.props.style.left}，期望 ${center(1) - 6}px`
    const up = verticalSegs(mainCell).find((node) => atLane(node, 1) && node.props.style.top === '-1px')
    if (up !== undefined) return 'main 的 tip 上方还画了连线'
    // 左泳道那条是 test 分支的直行线：它必须被画出来，否则两条分支看起来还是一条。
    const through = verticalSegs(mainCell).find((node) => atLane(node, 0))
    return through === undefined ? '左侧没有画 test 分支那条并行的线' : undefined
  })())

  ok('分叉之前两条泳道并行（左泳道是直行线，右泳道有圆点）', (() => {
    if (beforeForkCell === null) return '没找到分叉前一行的提交树单元格'
    const through = verticalSegs(beforeForkCell).find((node) => atLane(node, 0)
      && node.props.style.top === '-1px' && node.props.style.bottom === '-1px')
    if (through === undefined) return '左泳道没有直行线（看起来就像一条线而不是两条）'
    const dot = nodeDot(beforeForkCell)
    if (dot === null) return '没找到圆点'
    return dotAtLane(dot, 1) ? undefined : `圆点 left=${dot.props.style.left}，期望落在第 2 条泳道`
  })())

  ok('分叉点画在真正分叉的那次提交上（斜线从第 2 条泳道汇入第 1 条）', (() => {
    if (forkCell === null) return '没找到分叉提交的提交树单元格'
    const line = diagonalSegs(forkCell).find((node) => node.props.x1 === center(1) && node.props.x2 === center(0))
    if (line === undefined) return `没有从第 2 条泳道汇入第 1 条的斜线（斜线=${JSON.stringify(diagonalSegs(forkCell).map((node) => [node.props.x1, node.props.x2]))}）`
    if (line.props.y1 !== 0 || line.props.y2 !== 50 - NODE_EDGE_PCT) return `斜线纵向=${line.props.y1}→${line.props.y2}`
    const dot = nodeDot(forkCell)
    return dot !== null && dotAtLane(dot, 0) ? undefined : '分叉提交的圆点没落在第 1 条泳道'
  })())

  ok('分叉之后并成一条泳道（右泳道不再有线）', (() => {
    if (afterForkCell === null) return '没找到分叉后一行的提交树单元格'
    const stray = verticalSegs(afterForkCell).find((node) => atLane(node, 1))
    if (stray !== undefined) return '分叉之后第 2 条泳道还在画线'
    return diagonalSegs(afterForkCell).length === 0 ? undefined : '分叉之后还画了斜线'
  })())

  ok('还有更早提交时给出续拉提示（且提示可点：面板很高时撑不出滚动条）', (() => {
    const scroller = find(tree, (node) => typeof node.props?.onScroll === 'function')
    if (scroller === null) return '没找到提交树的滚动容器'
    if (texts(scroller).includes('滚动到底部继续加载更早的提交…') === false) return '没有续拉提示'
    const hint = find(tree, (node) => typeof node.props?.onClick === 'function' && typeof node.props?.title === 'string' && node.props.title.includes('更早的提交'))
    return hint === null ? '续拉提示行不可点' : undefined
  })())

  const scroller = find(tree, (node) => typeof node.props?.onScroll === 'function')
  if (scroller === null) {
    ok('滚动到底触发续拉', '没找到提交树的滚动容器')
  } else {
    scroller.props.onScroll({ currentTarget: { scrollTop: 9999, scrollHeight: 10000, clientHeight: 400 } })
    tree = await settle(render)
    const after = commitRows(tree)
    ok('滚到底续拉下一页（skip=已加载条数）', (() => {
      const payload = payloadOf('log')
      if (payload === null) return '滚到底没有发 log 请求'
      if (payload.skip !== SNAPSHOT) return `skip=${payload.skip}`
      return payload.all === true ? undefined : 'log 请求没带 all=true'
    })())
    ok('续拉按 hash 去重（重叠那条不重复渲染）', after.length === TOTAL ? undefined : `行数=${after.length}，期望 ${TOTAL}`)
    ok('拉到底后不再提示续拉', (() => {
      const box = find(tree, (node) => typeof node.props?.onScroll === 'function')
      return box === null || texts(box).includes('滚动到底部继续加载更早的提交…') === false ? undefined : '到底了还在提示续拉'
    })())
  }

  const refresh = findButton(tree, 'Refresh')
  if (refresh === null) {
    ok('刷新保留已加载深度', '没找到 Refresh 按钮')
  } else {
    refresh.props.onClick()
    tree = await settle(render)
    ok('刷新按已加载条数一次拉回（不缩回一页）', (() => {
      const payload = payloadOf('repo/snapshot')
      if (payload === null) return '刷新没有发 repo/snapshot'
      return payload.limit === TOTAL ? undefined : `刷新时 limit=${payload.limit}，期望 ${TOTAL}`
    })())
  }
}

/* -------------------------------------- 真实仓库对照：泳道分配 vs `git log --graph`
 * `node scripts/render-probe.mjs --real [仓库路径]`
 * 夹具只覆盖"两条泳道 + 一次分叉"这一种拓扑；这里把**真实仓库**的提交丢给同一份客户端代码，
 * 再跟 git 自己的 `--graph` 逐提交对比泳道下标（两者都用默认序取同一批提交，行序一致）。
 * git 的参考格式每行是「前缀 + 40 位哈希」，前缀里 `*` 的字符下标 ÷ 2 就是它给这条提交分的泳道。
 */
const realAt = process.argv.indexOf('--real')
if (realAt !== -1) {
  const realDir = process.argv[realAt + 1] ?? '.'
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, openSync, closeSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath, resolve: resolvePath } = await import('node:path')
  const scratch = mkdtempSync(joinPath(tmpdir(), 'gitvcs-graph-'))
  let seq = 0
  /** 沙箱下不能抓子进程管道输出，统一文件描述符重定向。 */
  const git = (args) => {
    const out = joinPath(scratch, `out-${seq++}.txt`)
    const fd = openSync(out, 'w')
    spawnSync('git', args, { cwd: resolvePath(realDir), env: process.env, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
    closeSync(fd)
    return readFileSync(out, 'utf8')
  }
  const LOG_FMT = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1e'
  const commits = git(['log', '--exclude=refs/stash', '--all', '--no-color', '--date=iso-strict', `--pretty=format:${LOG_FMT}`, '-n', '200'])
    .split('\x1e')
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((text) => text !== '')
    .map((text) => {
      const parts = text.split('\x1f')
      return {
        hash: parts[0],
        shortHash: parts[1],
        author: parts[2],
        email: parts[3],
        date: parts[4],
        parents: parts[5] === '' ? [] : parts[5].split(' '),
        subject: parts[6],
        body: (parts[7] ?? '').trim(),
      }
    })
  const reference = new Map()
  /** git 把"汇合/分叉"的斜线单独打印在前一行（形如 `|/`）：记下它后面那条提交。 */
  const gitForkRows = new Set()
  let previousLine = ''
  for (const line of git(['log', '--exclude=refs/stash', '--all', '--no-color', '--graph', '--pretty=format:%H', '-n', '200']).split('\n')) {
    const match = /^([^0-9a-f]*)([0-9a-f]{40})\s*$/.exec(line)
    if (match === null) { previousLine = line; continue }
    reference.set(match[2], match[1].indexOf('*') / 2)
    if (previousLine.includes('/')) gitForkRows.add(match[2])
    previousLine = line
  }
  const local = []
  const remote = []
  for (const line of git(['for-each-ref', '--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(objectname:short)%1f%(symref)', 'refs/heads', 'refs/remotes']).split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\x1f')
    if ((parts[4] ?? '') !== '') continue
    const kind = parts[0].startsWith('refs/heads/') ? 'local' : 'remote'
    const row = { ref: parts[0], name: parts[1], hash: parts[2], shortHash: parts[3], kind, upstream: '', ahead: 0, behind: 0, date: '', subject: '' }
    if (kind === 'local') local.push(row)
    else remote.push(row)
  }
  const headBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const headOid = git(['rev-parse', 'HEAD']).trim()
  const realSnapshot = (payload) => ({ ok: true, value: {
    repo: {
      cwd: realDir, root: realDir, branch: headBranch, detached: false,
      shortHead: headOid.slice(0, 7), oid: headOid, upstream: '', ahead: 0, behind: 0, remoteUrl: '', gitVersion: '',
    },
    config: { allowWrite: true, allowPush: true, allowDangerous: true, diffContextLines: 3, autoRefreshSeconds: 0 },
    status: { branch: { oid: headOid, head: headBranch, upstream: '', ahead: 0, behind: 0, detached: false }, entries: [] },
    commits: commits.slice(0, Math.min(payload.limit ?? 50, commits.length)),
    branches: { local, remote },
    stashes: [],
    console: [],
  } })

  realSource = realSnapshot
  const dump = process.env.PROBE_DUMP === '1'
  const refresh = findButton(tree, 'Refresh')
  if (refresh === null) {
    ok('真实仓库对照：渲染真实提交树', '没找到 Refresh 按钮，无法切换到真实数据')
  } else {
    refresh.props.onClick()
    tree = await settle(render)
    const mismatches = []
    const myForkRows = new Set()
    let compared = 0
    for (const row of commitRows(tree)) {
      const expected = reference.get(row.props.key)
      if (expected === undefined) continue
      const cell = find(row, (node) => node.props?.style?.display === 'flex' && node.props?.style?.gap === '4px')
      const dot = cell === null ? null : nodeDot(cell)
      if (dot === null) { mismatches.push(`${String(row.props.key).slice(0, 7)} 没画圆点`); continue }
      const lane = (parseFloat(dot.props.style.left) + 6 - LANE_GAP / 2) / LANE_GAP
      compared += 1
      if (lane !== expected) mismatches.push(`${String(row.props.key).slice(0, 7)} 我的泳道=${lane}，git=${expected}`)
      // 汇合斜线（y1 = 0 的那条）出现在哪一行，就是"分叉点画在哪一次提交上"。
      if (cell !== null && diagonalSegs(cell).some((line) => line.props.y1 === 0)) myForkRows.add(row.props.key)
      if (dump === true && cell !== null) {
        const verticals = verticalSegs(cell).map((node) => {
          const s = node.props.style
          const at = (parseFloat(s.left) + 1 - LANE_GAP / 2) / LANE_GAP
          const kind = s.height !== undefined ? 'up' : (s.bottom !== undefined && s.top === '-1px' ? 'through/down' : 'other')
          return `L${at}:${kind}(top=${s.top}${s.height === undefined ? '' : `,h=${s.height}`})`
        })
        const diagonals = diagonalSegs(cell).map((node) => `(${node.props.x1},${node.props.y1})→(${node.props.x2},${node.props.y2})`)
        console.log(`  #${compared - 1} ${String(row.props.key).slice(0, 7)} lane=${lane} | ${verticals.join(' ')} | ${diagonals.join(' ')}`)
      }
    }
    ok(`真实仓库 ${realDir}：${compared} 条提交的泳道与 git log --graph 一致`, (() => {
      if (compared === 0) return '一条都没对上（git 参考或渲染有问题）'
      return mismatches.length === 0 ? undefined : mismatches.slice(0, 6).join('；')
    })())
    ok('分叉点落在与 git 相同的提交上（汇合斜线所在行）', (() => {
      const mine = [...myForkRows]
      const theirs = [...gitForkRows]
      if (mine.length === 0 && theirs.length > 0) return `我这里一条汇合斜线都没有，git 有 ${theirs.length} 处`
      const missing = theirs.filter((hash) => myForkRows.has(hash) === false)
      if (missing.length > 0) return `git 在这些提交上画分叉，我没有：${missing.map((hash) => hash.slice(0, 7)).join(', ')}`
      return undefined
    })())
  }
}

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`)
process.exit(failed.length > 0 ? 1 : 0)
