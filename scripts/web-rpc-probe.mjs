/** 完整 DSH Web 组合测试：真实认证、RPC、Git 与客户端包分发；失败必须返回非零。 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { git } from '../tests/helpers.mjs'

const pluginDir = resolve(process.argv[2] ?? join(import.meta.dirname, '..'))
const testHome = mkdtempSync(join(tmpdir(), 'gitvcs-integration-'))
const profileDir = join(testHome, 'profiles', 'probe')
const repo = join(testHome, 'repo')
const portServer = createServer()
await new Promise((done, fail) => { portServer.once('error', fail); portServer.listen(0, '127.0.0.1', done) })
const port = portServer.address().port
await new Promise(done => portServer.close(done))
const base = `http://127.0.0.1:${port}`
let child, log = '', failure
try {
  mkdirSync(join(profileDir, 'node_modules', 'dsh-git-vcs'), { recursive: true })
  mkdirSync(repo)
  git(repo, 'init', '-b', 'integration')
  writeFileSync(join(repo, '测试.txt'), '真实宿主测试\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', '测试初始提交')
  for (const file of ['index.js', 'lib', 'package.json', 'cordis.patch.yml']) {
    cpSync(join(pluginDir, file), join(profileDir, 'node_modules', 'dsh-git-vcs', file), { recursive: true })
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-probe', private: true,
    dependencies: { 'dsh-git-vcs': 'file:./node_modules/dsh-git-vcs' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-git-vcs'] } },
  }), 'utf8')
  // 集成测试不需要文件监听；避免受测试机的 watcher 数量限制影响。
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n', 'utf8')
  const bin = process.env.DSH_BIN ?? 'dsh'
  child = spawn(bin.endsWith('.js') ? process.execPath : bin,
    [...(bin.endsWith('.js') ? [bin] : []), '--profile', 'probe', '--port', String(port), '--no-open'], {
      cwd: testHome, env: { ...process.env, DSH_HOME: testHome, DSH_WEB_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  child.on('error', error => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data.toString('utf8') })
  let authUrl
  for (let i = 0; i < 120; i++) {
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error(`DSH 提前退出：${child.exitCode}`)
    authUrl = log.match(/https?:\/\/[^\s\u001b<>"']+[?&]token=[^\s\u001b<>"']+/)?.[0]
    if (log.includes('entries did not activate')) throw new Error('宿主插件未全部激活')
    if (authUrl && log.includes('RPC 通道已注册')) break
    await new Promise(done => setTimeout(done, 500))
  }
  assert.ok(authUrl, '启动日志未提供认证 URL')
  const unauth = await fetch(`${base}/git-vcs/repo/snapshot`, { method: 'POST', body: '{}' })
  assert.equal(unauth.status, 401, '未认证请求必须拒绝')
  console.log('OK 未认证 RPC → 401')
  const login = await fetch(authUrl, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, '认证响应没有 cookie')
  const invoke = async (endpoint, payload, extra = {}) => {
    const response = await fetch(`${base}/git-vcs/${endpoint}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'integration', method: endpoint, payload, ...extra }),
    })
    assert.equal(response.status, extra.method && extra.method !== endpoint ? 400 : 200)
    const envelope = await response.json()
    assert.equal(envelope.type, 'server-response')
    assert.equal(envelope.rpcId, 'integration')
    return envelope.result
  }
  const snapshot = await invoke('repo/snapshot', { cwd: repo, all: true })
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot))
  assert.equal(snapshot.value.repo.branch, 'integration')
  assert.equal(snapshot.value.commits.length, 1)
  console.log('OK 认证后的真实 subprocess / repo/snapshot')
  writeFileSync(join(repo, '新文件.txt'), '暂存内容', 'utf8')
  assert.equal((await invoke('stage', { cwd: repo, paths: ['新文件.txt'] })).ok, true)
  assert.ok(git(repo, 'diff', '--cached', '--name-only').includes('新文件.txt'))
  assert.equal((await invoke('unstage', { cwd: repo, all: true })).ok, true)
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), '')
  console.log('OK 认证后的暂存和取消暂存')
  const mismatch = await invoke('status', { cwd: repo }, { method: 'stage' })
  assert.equal(mismatch.ok, false)
  const inherited = await invoke('constructor', {})
  assert.equal(inherited.error.code, 'git-vcs/unknown-endpoint')
  const forbidden = await fetch(`${base}/git-vcs/status`, {
    method: 'POST', headers: { cookie, origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(forbidden.status, 403)
  console.log('OK 协议 method 校验、未知端点与 Origin 栅栏')
  const html = await fetch(base, { headers: { cookie } }).then(response => response.text())
  const bootText = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(.*?)<\/script>/s)?.[1]
  assert.ok(bootText, '页面缺少真实客户端启动图')
  const boot = JSON.parse(bootText)
  const entry = boot.entries.find(value => value.id === 'dsh-git-vcs')
  assert.ok(entry, '插件未进入客户端启动图')
  const client = await fetch(new URL(entry.url, base), { headers: { cookie } })
  assert.equal(client.status, 200)
  assert.ok((await client.text()).includes('__ModuleLoader__'))
  console.log('OK 浏览器半区成功分发')
} catch (error) {
  // 启动日志可能带认证令牌，仅输出脱敏后的诊断。
  console.error(log.replace(/(token=)[^\s\u001b"'<>]+/g, '$1[已隐藏]').slice(-12000))
  throw error
} finally {
  if (child && child.exitCode === null && !failure) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise(done => setTimeout(done, 3000))])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  rmSync(testHome, { recursive: true, force: true })
}
