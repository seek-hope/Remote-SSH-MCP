import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEditTool, hasBinaryContent } from '../src/tools/files.js'

const target = { ssh: 'h', name: 'h' }
const exec = { signal: new AbortController().signal }
const edit = makeEditTool(target, '/remote', (p) => p)

test('edit rejects empty old_string before any ssh call', async () => {
  await assert.rejects(
    () => edit.execute({ file_path: '/f', old_string: '', new_string: 'x' }, exec),
    /old_string must be a non-empty string/,
  )
})

test('edit rejects NUL bytes in old_string and new_string', async () => {
  await assert.rejects(
    () => edit.execute({ file_path: '/f', old_string: 'a\0b', new_string: 'x' }, exec),
    /UTF-8/,
  )
  await assert.rejects(
    () => edit.execute({ file_path: '/f', old_string: 'a', new_string: 'x\0y' }, exec),
    /UTF-8/,
  )
})

test('edit rejects lone surrogates (data that cannot be UTF-8)', async () => {
  await assert.rejects(
    () => edit.execute({ file_path: '/f', old_string: 'a\ud800b', new_string: 'x' }, exec),
    /UTF-8/,
  )
})

test('hasBinaryContent detects NUL and lone surrogates, accepts normal text', () => {
  assert.equal(hasBinaryContent('hello'), false)
  assert.equal(hasBinaryContent('中文 text'), false)
  assert.equal(hasBinaryContent('😀'), false) // valid surrogate pair
  assert.equal(hasBinaryContent('a\0b'), true)
  assert.equal(hasBinaryContent('a\ud800b'), true)
  assert.equal(hasBinaryContent('a\ud800'), true)
  assert.equal(hasBinaryContent('a\udc00b'), true)
})
