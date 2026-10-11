/** 在独立 VM 中验证真实成功结果可无损 JSON 序列化；路径使用本机实现。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { runInNewContext } from 'node:vm'
import { host } from '../tests/helpers.mjs'

const cwd = resolvePath(process.argv[2] ?? process.cwd())
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')
const apply = runInNewContext(`${source}\napply`, {
  stat, realpath, isAbsolute, relative, resolvePath, AbortSignal, AbortController, Buffer, process: { platform: process.platform }, console,
})
const call = host({}, apply)
for (const [endpoint, extra] of [
  ['repo/snapshot', { limit: 10 }], ['repo/info', {}], ['show', { rev: 'HEAD', noPatch: true }],
  ['show/file', { rev: 'HEAD', path: 'README.md' }], ['console/list', {}], ['remote/list', {}],
]) {
  const result = await call(endpoint, { cwd, ...extra })
  assert.equal(result.ok, true, JSON.stringify(result))
  const encoded = JSON.stringify(result, (_key, value) => {
    assert.notEqual(value, undefined, '结果不应包含 undefined')
    if (typeof value === 'number') assert.ok(Number.isFinite(value) && !Object.is(value, -0))
    return value
  })
  assert.equal(JSON.stringify(JSON.parse(encoded)), encoded)
  console.log(`OK   ${endpoint} → 成功且无损 JSON`)
}
