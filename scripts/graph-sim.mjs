/**
 * 提交树泳道算法离线仿真（开发用，不参与插件运行）。
 *
 * 目的：用真实仓库的数据（git log --all 的默认顺序）跑一遍 lib/client.js 里的
 * 泳道布局算法，把结果画成 ASCII，和 `git log --graph` 对照，定位「合并线外突折返」
 * 与「底部凭空出现的线」这类几何问题。
 *
 * 用法：node scripts/graph-sim.mjs <仓库路径> [条数] [算法=old|new]
 *
 * 每行提交画 3 条字符线（对应 GraphCell 里的 top / 圆心 / bottom）：
 *   · │ 该泳道在本行内直行；╱ ╲ 斜线（out = 从圆点向下岔出，in = 从上方汇入圆点）。
 */
import { execFileSync } from 'node:child_process'

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%P%x1f%s%x1f%b%x1e'
const BRANCH_FORMAT = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:iso-strict)%1f%(subject)%1f%(objectname)%1f%(symref)'
const PALETTE = 8

const repo = process.argv[2]
const limit = Number(process.argv[3] ?? 60)
const algo = process.argv[4] ?? 'old'

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

function parseCommits(stdout) {
  const commits = []
  for (const chunk of stdout.split('\x1e')) {
    const text = chunk.replace(/^\n+/, '')
    if (text === '') continue
    const parts = text.split('\x1f')
    if (parts.length < 7) continue
    commits.push({
      hash: parts[0],
      shortHash: parts[1],
      date: parts[4],
      parents: parts[5] === '' ? [] : parts[5].split(' '),
      subject: parts[6],
    })
  }
  return commits
}

function parseBranches(stdout) {
  const local = []
  const remote = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\x1f')
    if (parts.length < 7) continue
    if ((parts[8] ?? '') !== '') continue
    const row = { name: parts[1], hash: parts[7] ?? '', kind: parts[0].startsWith('refs/heads/') ? 'local' : 'remote' }
    if (row.kind === 'local') local.push(row)
    else remote.push(row)
  }
  return { local, remote }
}

const head = (() => {
  try {
    return git(['symbolic-ref', '--short', 'HEAD']).trim()
  } catch {
    return ''
  }
})()

const commits = parseCommits(git(['log', '--no-color', '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`, '--exclude=refs/stash', '--all', '-n', String(limit)]))
const branches = parseBranches(git(['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']))

const tips = new Map()
{
  const collect = (list, kind) => {
    for (const item of list) {
      if (kind === 'remote' && /(^|\/)HEAD$/.test(item.name) === true) continue
      if (item.hash === '') continue
      const label = { name: item.name, kind, head: kind === 'local' && item.name === head }
      const rows = tips.get(item.hash)
      if (rows === undefined) tips.set(item.hash, [label])
      else rows.push(label)
    }
  }
  collect(branches.local, 'local')
  collect(branches.remote, 'remote')
}

const names = []
for (const rows of tips.values()) for (const label of rows) if (names.includes(label.name) === false) names.push(label.name)
names.sort((a, b) => a.localeCompare(b))
const colorByName = new Map()
for (let i = 0; i < names.length; i++) colorByName.set(names[i], i % PALETTE)

/** 与 lib/client.js 的 logLaneLayout 等价的旧算法。 */
function layoutOld() {
  const lanes = []
  const rows = new Map()
  let maxLanes = 0
  const freeColor = () => {
    const used = new Set()
    for (const lane of lanes) if (lane !== null) used.add(lane.color)
    for (let i = 0; i < PALETTE; i++) if (used.has(i) === false) return i
    return lanes.length % PALETTE
  }
  const colorOfCommit = (hash) => {
    let best
    for (const label of tips.get(hash) ?? []) {
      const priority = label.head === true ? 0 : (label.kind === 'local' ? 1 : 2)
      if (best === undefined || priority < best.priority) best = { priority, name: label.name }
    }
    if (best === undefined) return freeColor()
    const index = colorByName.get(best.name)
    return index === undefined ? freeColor() : index
  }
  const allocLane = () => {
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }
  for (const commit of commits) {
    const before = lanes.slice()
    let lane = -1
    for (let i = 0; i < lanes.length; i++) if (lanes[i] !== null && lanes[i].hash === commit.hash) { lane = i; break }
    const merges = []
    let incoming = false
    let color
    if (lane === -1) {
      lane = allocLane()
      color = colorOfCommit(commit.hash)
    } else {
      incoming = true
      color = lanes[lane].color
      for (let i = lane + 1; i < lanes.length; i++) if (lanes[i] !== null && lanes[i].hash === commit.hash) merges.push(i)
    }
    for (const i of merges) lanes[i] = null
    const parents = commit.parents
    const outLanes = []
    lanes[lane] = null
    if (parents.length > 0) {
      lanes[lane] = { hash: parents[0], color }
      for (let i = 1; i < parents.length; i++) {
        const other = allocLane()
        lanes[other] = { hash: parents[i], color }
        outLanes.push(other)
      }
    }
    const laneCount = Math.max(before.length, lanes.length)
    const verticals = []
    for (let i = 0; i < laneCount; i++) {
      if (i === lane) continue
      const was = before[i] === undefined ? null : before[i]
      const now = lanes[i] === undefined ? null : lanes[i]
      if (was !== null && now !== null && was.hash === now.hash) verticals.push({ lane: i, kind: 'through', color: was.color })
    }
    if (incoming) verticals.push({ lane, kind: 'up', color: before[lane].color })
    if (parents.length > 0) verticals.push({ lane, kind: 'down', color })
    const diagonals = []
    for (const i of merges) diagonals.push({ from: i, to: lane, dir: 'in', color: before[i].color })
    for (const i of outLanes) diagonals.push({ from: lane, to: i, dir: 'out', color: lanes[i].color })
    maxLanes = Math.max(maxLanes, laneCount)
    rows.set(commit.hash, { lane, color, verticals, diagonals })
  }
  return { rows, maxLanes }
}

/** 修正版：合并的其它父提交优先复用「已经在等这个提交」的泳道，避免多开一条又马上折回。 */
function layoutNew() {
  const lanes = []
  const rows = new Map()
  let maxLanes = 0
  const freeColor = () => {
    const used = new Set()
    for (const lane of lanes) if (lane !== null) used.add(lane.color)
    for (let i = 0; i < PALETTE; i++) if (used.has(i) === false) return i
    return lanes.length % PALETTE
  }
  const colorOfCommit = (hash) => {
    let best
    for (const label of tips.get(hash) ?? []) {
      const priority = label.head === true ? 0 : (label.kind === 'local' ? 1 : 2)
      if (best === undefined || priority < best.priority) best = { priority, name: label.name }
    }
    if (best === undefined) return freeColor()
    const index = colorByName.get(best.name)
    return index === undefined ? freeColor() : index
  }
  const allocLane = (prefer) => {
    if (Number.isInteger(prefer) && prefer >= 0) return prefer
    const free = lanes.indexOf(null)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }
  for (const commit of commits) {
    const before = lanes.slice()
    let lane = -1
    for (let i = 0; i < lanes.length; i++) if (lanes[i] !== null && lanes[i].hash === commit.hash) { lane = i; break }
    const merges = []
    let incoming = false
    let color
    if (lane === -1) {
      lane = allocLane()
      color = colorOfCommit(commit.hash)
    } else {
      incoming = true
      color = lanes[lane].color
      for (let i = lane + 1; i < lanes.length; i++) if (lanes[i] !== null && lanes[i].hash === commit.hash) merges.push(i)
    }
    for (const i of merges) lanes[i] = null
    const parents = commit.parents
    const diagonals = []
    lanes[lane] = null
    if (parents.length > 0) {
      lanes[lane] = { hash: parents[0], color }
      for (let i = 1; i < parents.length; i++) {
        // 关键修正：合并的"其它父提交"如果已经被某条泳道期待，就并进那条泳道，
        // 不再新开一条 —— 否则会画出一条向右突出、下一行又折回来的假分叉。
        const existing = lanes.findIndex((item, index) => index !== lane && item !== null && item.hash === parents[i])
        if (existing !== -1) {
          diagonals.push({ from: lane, to: existing, dir: 'out', color: lanes[existing].color })
        } else {
          const other = allocLane()
          lanes[other] = { hash: parents[i], color }
          diagonals.push({ from: lane, to: other, dir: 'out', color: lanes[other].color })
        }
      }
    }
    const laneCount = Math.max(before.length, lanes.length)
    const verticals = []
    for (let i = 0; i < laneCount; i++) {
      if (i === lane) continue
      const was = before[i] === undefined ? null : before[i]
      const now = lanes[i] === undefined ? null : lanes[i]
      if (was !== null && now !== null && was.hash === now.hash && was.hash !== commit.hash) verticals.push({ lane: i, kind: 'through', color: was.color })
    }
    if (incoming) verticals.push({ lane, kind: 'up', color: before[lane].color })
    if (parents.length > 0 && lanes[lane] !== null) verticals.push({ lane, kind: 'down', color })
    for (const i of merges) diagonals.push({ from: i, to: lane, dir: 'in', color: before[i].color })
    maxLanes = Math.max(maxLanes, laneCount)
    rows.set(commit.hash, { lane, color, verticals, diagonals })
  }
  return { rows, maxLanes }
}

const layout = algo === 'new' ? layoutNew() : layoutOld()
const width = Math.max(2, layout.maxLanes)
const x = (lane) => lane * 2

function renderRow(row) {
  const top = new Array(width * 2).fill(' ')
  const mid = new Array(width * 2).fill(' ')
  const bot = new Array(width * 2).fill(' ')
  for (const seg of row.verticals) {
    const at = x(seg.lane)
    if (seg.kind === 'up') top[at] = '│'
    else if (seg.kind === 'down') bot[at] = '│'
    else { top[at] = '│'; mid[at] = '│'; bot[at] = '│' }
  }
  for (const seg of row.diagonals) {
    if (seg.dir === 'in') {
      top[x(seg.from)] = seg.from > seg.to ? '╲' : '╱'
      mid[x(seg.to)] = '●'
    } else {
      bot[x(seg.to)] = seg.to > seg.from ? '╲' : '╱'
      mid[x(seg.from)] = '●'
    }
  }
  mid[x(row.lane)] = '●'
  return { top: top.join(''), mid: mid.join(''), bot: bot.join('') }
}

const out = []
out.push(`# 算法=${algo}  ${repo}  提交=${commits.length}  泳道=${layout.maxLanes}  HEAD=${head}`)
out.push(`# 分支：${names.join('  ')}`)
for (let i = 0; i < commits.length; i++) {
  const commit = commits[i]
  const row = layout.rows.get(commit.hash)
  const mark = commit.parents.length > 1 ? ` ⟨MERGE ${commit.parents.length}⟩` : ''
  const tag = (tips.get(commit.hash) ?? []).map((label) => label.name).join(',')
  const bar = `${(i + 1).toString().padStart(3, ' ')} `
  const label = `${commit.shortHash}${mark}${tag === '' ? '' : ` [${tag}]`} ${commit.subject.slice(0, 44)}`
  const art = renderRow(row)
  out.push(`${bar}${art.top}  ${i === 0 ? label : ''}`)
  out.push(`${bar}${art.mid}  ${label}`)
  out.push(`${bar}${art.bot}`)
}
// 末行之后是否还挂着线（= 没有下文的线）
const last = layout.rows.get(commits[commits.length - 1].hash)
if (last !== null && last !== undefined) {
  const art = renderRow(last)
  if (art.bot.trim() !== '') out.push(`# !! 末行下方仍有线：${art.bot}`)
}
// 悬浮泳道检测：整段窗口里出现在画面上、却一个节点都没有的泳道（用户报的"没有开始的分支线"）
const withNode = new Set()
const withLine = new Set()
for (const commit of commits) {
  const row = layout.rows.get(commit.hash)
  withNode.add(row.lane)
  for (const seg of row.verticals) withLine.add(seg.lane)
  for (const seg of row.diagonals) { withLine.add(seg.from); withLine.add(seg.to) }
}
const floating = [...withLine].filter((lane) => withNode.has(lane) === false).sort((a, b) => a - b)
out.push(`# 有节点泳道=${[...withNode].sort((a, b) => a - b).join(',')}  出现连线泳道=${[...withLine].sort((a, b) => a - b).join(',')}  无节点泳道=${floating.length === 0 ? '（无）' : floating.join(',')}`)

// 尖角检测：上一行向右岔出到泳道 L、下一行又从 L 折回来 —— 合并线的"外突折返"
const spikes = []
for (let i = 0; i + 1 < commits.length; i++) {
  const up = layout.rows.get(commits[i].hash)
  const down = layout.rows.get(commits[i + 1].hash)
  for (const seg of up.diagonals) {
    if (seg.dir !== 'out') continue
    for (const back of down.diagonals) {
      if (back.dir === 'in' && back.from === seg.to && seg.to > seg.from) {
        spikes.push(`${commits[i].shortHash}→${commits[i + 1].shortHash} 泳道${seg.from}→${seg.to}→${back.to}`)
      }
    }
  }
}
out.push(`# 外突折返尖角：${spikes.length === 0 ? '（无）' : spikes.join('  ')}`)
console.log(out.join('\n'))
