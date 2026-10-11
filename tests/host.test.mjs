import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { host, scratch, git } from './helpers.mjs'

async function ok(call, endpoint, payload) {
  const result = await call(endpoint, payload)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}
function repo(t, initial = true) {
  const cwd = scratch(t)
  git(cwd, 'init', '-b', 'main')
  if (initial) {
    writeFileSync(join(cwd, '基础.txt'), '初始内容\n', 'utf8')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', '初始提交')
  }
  return cwd
}

test('首次提交前取消暂存保留文件，并支持全部取消', async t => {
  const cwd = repo(t, false), call = host()
  writeFileSync(join(cwd, '新文件.txt'), '内容', 'utf8')
  await ok(call, 'stage', { cwd, paths: ['新文件.txt'] })
  await ok(call, 'unstage', { cwd, paths: ['新文件.txt'] })
  assert.equal(git(cwd, 'ls-files'), '')
  assert.equal(readFileSync(join(cwd, '新文件.txt'), 'utf8'), '内容')
  await ok(call, 'stage', { cwd, all: true })
  await ok(call, 'unstage', { cwd, all: true })
  assert.equal(git(cwd, 'ls-files'), '')
})

test('选择含通配符的文件不会误暂存其它文件', async t => {
  const cwd = repo(t), call = host()
  for (const path of ['[a].txt', 'a.txt']) writeFileSync(join(cwd, path), path, 'utf8')
  await ok(call, 'stage', { cwd, paths: ['[a].txt'] })
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '[a].txt')
  assert.equal((await call('stage', { cwd, paths: [] })).error.code, 'git-vcs/bad-request')
})

test('贮藏可包含未跟踪文件，空操作不返回虚假的新记录', async t => {
  const cwd = repo(t), call = host()
  writeFileSync(join(cwd, '未跟踪.txt'), '保留内容', 'utf8')
  const skipped = await ok(call, 'stash', { cwd, action: 'push' })
  assert.equal(skipped.created, false)
  assert.equal(skipped.ref, null)
  const saved = await ok(call, 'stash', { cwd, action: 'push', includeUntracked: true })
  assert.equal(saved.created, true)
  assert.equal(existsSync(join(cwd, '未跟踪.txt')), false)
  const empty = await ok(call, 'stash', { cwd, action: 'push', includeUntracked: true })
  assert.equal(empty.created, false)
  assert.equal(empty.ref, null)
  await ok(call, 'stash', { cwd, action: 'pop', ref: saved.ref })
  assert.equal(readFileSync(join(cwd, '未跟踪.txt'), 'utf8'), '保留内容')
})

test('repoRoot 拒绝符号链接逃逸和向上寻找的仓库根', async t => {
  const allowed = scratch(t), outside = repo(t), call = host({ repoRoot: allowed })
  symlinkSync(outside, join(allowed, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await call('status', { cwd: join(allowed, 'link') })).error.code, 'git-vcs/outside-root')
  const child = join(outside, 'child')
  mkdirSync(child)
  const restricted = host({ repoRoot: child })
  assert.equal((await restricted('stage', { cwd: child, all: true })).error.code, 'git-vcs/outside-root')
  const dotted = join(allowed, '..合法目录')
  mkdirSync(dotted)
  await ok(call, 'repo/init', { cwd: dotted })
})

test('继承属性不是 RPC 端点', async () => {
  const call = host()
  for (const endpoint of ['constructor', 'toString', '__proto__']) {
    assert.equal((await call(endpoint, {})).error.code, 'git-vcs/unknown-endpoint')
  }
})

test('真实本地远程的提交、推送、抓取、分支与回滚流程', async t => {
  const cwd = repo(t), remote = scratch(t), call = host()
  git(remote, 'init', '--bare')
  await ok(call, 'remote/add', { cwd, name: 'origin', url: remote })
  await ok(call, 'push', { cwd, remote: 'origin', branch: 'main', setUpstream: true })
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), git(cwd, 'rev-parse', 'HEAD'))
  const peer = scratch(t)
  git(peer, 'clone', '-b', 'main', remote, '.')
  writeFileSync(join(peer, '远程.txt'), '远程更新', 'utf8')
  git(peer, 'add', '.')
  git(peer, 'commit', '-m', '远程更新')
  git(peer, 'push')
  await ok(call, 'pull', { cwd })
  assert.equal(readFileSync(join(cwd, '远程.txt'), 'utf8'), '远程更新')
  await ok(call, 'branch/create', { cwd, name: 'feature', checkout: true })
  writeFileSync(join(cwd, '功能.txt'), '功能', 'utf8')
  await ok(call, 'commit', { cwd, paths: ['功能.txt'], message: '增加功能' })
  await ok(call, 'fetch', { cwd, remote: 'origin' })
  await ok(call, 'checkout', { cwd, ref: 'main' })
  await ok(call, 'merge', { cwd, ref: 'feature' })
  assert.equal(existsSync(join(cwd, '功能.txt')), true)
  await ok(call, 'revert', { cwd, rev: 'HEAD' })
  assert.equal(existsSync(join(cwd, '功能.txt')), false)
})

test('未跟踪文件 diff 拒绝仓库外文件和外部符号链接', async t => {
  const cwd = repo(t), outside = scratch(t), call = host()
  const file = join(outside, '外部.txt')
  writeFileSync(file, '不可读取', 'utf8')
  assert.equal((await call('diff', { cwd, path: file, untracked: true })).error.code, 'git-vcs/outside-root')
  if (process.platform !== 'win32') {
    symlinkSync(file, join(cwd, '链接.txt'))
    assert.equal((await call('diff', { cwd, path: '链接.txt', untracked: true })).error.code, 'git-vcs/outside-root')
  }
})

test('拣选、重置、丢弃和危险操作门禁', async t => {
  const cwd = repo(t), call = host(), base = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'checkout', '-b', 'topic')
  writeFileSync(join(cwd, '拣选.txt'), '内容', 'utf8')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', '待拣选')
  const rev = git(cwd, 'rev-parse', 'HEAD')
  git(cwd, 'checkout', 'main')
  await ok(call, 'cherry-pick', { cwd, rev })
  assert.equal(readFileSync(join(cwd, '拣选.txt'), 'utf8'), '内容')
  const restricted = host({ allowDangerous: false })
  for (const endpoint of ['reset', 'revert', 'cherry-pick', 'branch/delete', 'discard']) {
    assert.equal((await restricted(endpoint, { cwd, rev: base, paths: ['拣选.txt'], name: 'topic', mode: 'hard' })).error.code,
      'git-vcs/dangerous-disabled')
  }
  await ok(call, 'reset', { cwd, rev: base, mode: 'hard' })
  assert.equal(existsSync(join(cwd, '拣选.txt')), false)
  writeFileSync(join(cwd, '基础.txt'), '修改', 'utf8')
  writeFileSync(join(cwd, '多余.txt'), '多余', 'utf8')
  await ok(call, 'discard', { cwd, paths: ['基础.txt', '多余.txt'] })
  assert.equal(git(cwd, 'status', '--porcelain'), '')
  await ok(call, 'branch/delete', { cwd, name: 'topic', force: true })
  assert.equal(git(cwd, 'branch', '--list', 'topic'), '')
})
