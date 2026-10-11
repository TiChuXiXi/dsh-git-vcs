import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'
import { scratch } from './helpers.mjs'

function routeFor(subprocess = {}) {
  let route
  const connection = { requestRejection: () => undefined }
  apply({ connection, get: key => ({ subprocess, connection,
    webServer: { register(value) { route = value; return () => {} } },
  })[key], effect: fn => fn() }, {})
  return route
}
function response() {
  const res = new EventEmitter()
  res.writeHead = code => { res.status = code }
  res.end = body => { res.body = body; res.writableEnded = true }
  return res
}
function request(body, extra = {}) {
  return {
    method: 'POST', url: '/git-vcs/status', headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') }, ...extra,
  }
}
test('RPC 拒绝错误 HTTP 方法、媒体类型、JSON 和端点信封', async () => {
  const route = routeFor()
  const valid = { type: 'client-request', rpcId: 'test', method: 'status', payload: {} }
  for (const [req, code] of [
    [request('{}', { method: 'GET' }), 405],
    [request('{}', { headers: { 'content-type': 'text/plain' } }), 415],
    [request('{broken'), 400], [request('null'), 400],
    [request(JSON.stringify({ ...valid, type: 'wrong' })), 400],
    [request(JSON.stringify({ ...valid, method: 'stage' })), 400],
    [request(JSON.stringify({ ...valid, payload: [] })), 400],
    [request(JSON.stringify({ ...valid, payload: 'invalid' })), 400],
  ]) {
    const res = response()
    await route.handler(req, res)
    assert.equal(res.status, code)
  }
})

test('客户端断开连接会取消正在运行的 Git，取消不误报超时', async t => {
  const cwd = scratch(t), res = response()
  let aborted = false
  const route = routeFor({
    async resolveExecutable() { return 'git' },
    spawn(spec) {
      return { done: new Promise((_resolve, reject) => {
        spec.signal.addEventListener('abort', () => { aborted = true; reject(new Error('取消')) }, { once: true })
        queueMicrotask(() => res.emit('close'))
      }) }
    },
  })
  await route.handler(request(JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'status', payload: { cwd } })), res)
  assert.equal(aborted, true)
  assert.equal(JSON.parse(res.body).result.error.code, 'git-vcs/cancelled')
  assert.equal(res.listenerCount('close'), 0)
})
