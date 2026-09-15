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
const findButton = (tree, label) => find(tree, (node) => node.type === 'button' && texts(node).includes(label))
/** 提交行：带 onContextMenu 的 div（右键菜单是提交行独有的）。 */
const commitRows = (tree) => {
  const rows = []
  walk(tree, (node) => { if (typeof node.props?.onContextMenu === 'function') rows.push(node) })
  return rows
}

/* ------------------------------------------------------------------ 夹具数据 */

const SNAPSHOT = 50
const TOTAL = 55

const mkHash = (index) => `${String(index).padStart(2, '0')}f`.repeat(20)
/** 第 3 条故意做成「只在 feature/x 上」：main 的第 2 条直接指向第 4 条，绕开它。 */
const parentsOf = (index) => {
  if (index === 2 || index === 3) return [mkHash(4)]
  return index + 1 < TOTAL ? [mkHash(index + 1)] : []
}
const mkCommit = (index) => ({
  hash: mkHash(index),
  shortHash: mkHash(index).slice(0, 7),
  author: 'verify',
  email: 'verify@test',
  date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  parents: parentsOf(index),
  subject: index === 3 ? 'feature/x 独有的提交' : `提交 ${index}`,
  body: '',
})

const COMMITS = Array.from({ length: TOTAL }, (_, index) => mkCommit(index))
/** 不带 all 的 `git log` 只走 HEAD 的祖先链，拿不到第 3 条 —— 夹具必须照这个语义给数据。 */
const reachable = (all) => (all === true ? COMMITS : COMMITS.filter((_, index) => index !== 3))
const calls = []
const payloadOf = (endpoint) => {
  const hit = [...calls].reverse().find((row) => row.endpoint === endpoint)
  return hit === undefined ? null : hit.payload
}

async function fakeCall(channel, endpoint, payload) {
  calls.push({ endpoint, payload })
  if (endpoint === 'repo/snapshot') {
    const limit = Math.min(payload.limit ?? SNAPSHOT, TOTAL)
    const visible = reachable(payload.all)
    return { ok: true, value: {
      repo: {
        cwd: 'D:/fixture', root: 'D:/fixture', branch: 'main', detached: false,
        shortHead: COMMITS[0].shortHash, oid: COMMITS[0].hash, upstream: 'origin/main',
        ahead: 0, behind: 0, remoteUrl: 'https://example.com/fixture.git', gitVersion: 'git version 2.49.0',
      },
      config: { allowWrite: true, allowPush: true, allowDangerous: true, diffContextLines: 3, autoRefreshSeconds: 0 },
      status: { branch: { oid: COMMITS[0].hash, head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false }, entries: [] },
      commits: visible.slice(0, limit),
      branches: {
        local: [
          { ref: 'refs/heads/main', name: 'main', shortHash: COMMITS[0].shortHash, hash: COMMITS[0].hash, kind: 'local', upstream: 'origin/main', ahead: 0, behind: 0, date: COMMITS[0].date, subject: COMMITS[0].subject },
          { ref: 'refs/heads/feature/x', name: 'feature/x', shortHash: COMMITS[3].shortHash, hash: COMMITS[3].hash, kind: 'local', upstream: '', ahead: 0, behind: 0, date: COMMITS[3].date, subject: COMMITS[3].subject },
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

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL'))
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`)
process.exit(failed.length > 0 ? 1 : 0)
