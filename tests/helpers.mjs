import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** 使用真实 Git，隔离用户身份、签名和凭据配置。 */
export const testEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: testEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
export function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gitvcs-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
export const subprocess = {
  async resolveExecutable(command) { return command },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, env: { ...testEnv, ...spec.env }, signal: spec.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const buffers = { stdout: [], stderr: [] }
    for (const key of Object.keys(buffers)) child[key].on('data', chunk => buffers[key].push(chunk))
    child.stdin.on('error', () => {})
    child.stdin.end(typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined)
    return {
      done: new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
      }),
      collected: Object.fromEntries(Object.keys(buffers).map(key => [key, { readFrom() {
        const data = Buffer.concat(buffers[key]), max = spec.stdio[key].maxBytes
        return { text: data.subarray(-max).toString('utf8'), lossy: data.length > max }
      } }])),
    }
  },
}
export function host(config = {}, applyPlugin = apply) {
  let route
  const connection = { requestRejection: () => undefined }
  const webServer = { register(value) { route = value; return () => { route = undefined } } }
  applyPlugin({
    connection,
    get: key => ({ subprocess, connection, webServer })[key],
    effect: fn => fn(),
  }, config)
  if (!route) throw new Error('插件未注册 RPC')
  return (endpoint, payload) => callRegisteredRoute(route, endpoint, payload)
}

/** 通过真实插件的 HTTP 处理器调用，验证注册和信封，而不复制端点实现。 */
export async function callRegisteredRoute(route, endpoint, payload) {
  let status, body
  await route.handler({
    method: 'POST', url: `/git-vcs/${endpoint}`, headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'test', method: endpoint, payload }))
    },
  }, { writeHead(value) { status = value }, end(value) { body = value } })
  if (status !== 200) throw new Error(`HTTP ${status}: ${body}`)
  return JSON.parse(body).result
}
