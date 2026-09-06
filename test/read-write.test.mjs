import test from 'node:test'
import assert from 'node:assert/strict'
import { makeReadTool, makeWriteTool, makeEditTool } from '../src/tools/files.js'
import { installFakeSsh } from './helpers.mjs'

const MiB = 1024 * 1024
const target = { ssh: 'h', name: 'h', controlPersist: 0 }
const exec = { signal: new AbortController().signal }
const read = makeReadTool(target, '/remote', (p) => p)
const write = makeWriteTool(target, '/remote', (p) => p)
const edit = makeEditTool(target, '/remote', (p) => p)

test('read parses a tail-located count (file without trailing newline)', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_STDOUT = 'alpha\nbeta\n__SEP__\n2'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await read.execute({ file_path: '/f' }, exec)
    assert.ok(out.includes('1\talpha'))
    assert.ok(out.includes('2\tbeta'))
    assert.ok(out.includes('(End of file - total 2 lines)'), `footer wrong: ${out}`)
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('read keeps the body trailing-newline ambiguity straight', async () => {
  const fake = await installFakeSsh()
  // body 'alpha\nbeta\n' (file WITH trailing newline): the separator's echo
  // adds exactly one more '\n', which the parser must not attribute to the body
  process.env.FAKE_SSH_STDOUT = 'alpha\nbeta\n\n__SEP__\n2'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await read.execute({ file_path: '/f' }, exec)
    assert.ok(out.includes('2\tbeta'))
    assert.ok(out.includes('(End of file - total 2 lines)'), `footer wrong: ${out}`)
    assert.ok(!out.includes('3\t'), 'no phantom empty third line')
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('read rejects binary content (U+FFFD from undecodable bytes, control chars)', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  try {
    process.env.FAKE_SSH_STDOUT = 'ab\uFFFDcd\n__SEP__\n1' // undecodable bytes decode to U+FFFD
    await assert.rejects(() => read.execute({ file_path: '/f' }, exec), /does not look like a UTF-8 text file/)
    process.env.FAKE_SSH_STDOUT = 'a\x01b\n__SEP__\n1'
    await assert.rejects(() => read.execute({ file_path: '/f' }, exec), /does not look like a UTF-8 text file/)
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('read accepts CJK / emoji text (sniff has no false positives on non-ASCII)', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_STDOUT = '中文 一行\n😀 ok\n__SEP__\n2'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await read.execute({ file_path: '/f' }, exec)
    assert.ok(out.includes('1\t中文 一行'))
    assert.ok(out.includes('2\t😀 ok'))
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('read of a window larger than the 4 MiB stdout cap still finds the count', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_BIG = String(5 * MiB) // body (no newlines), head truncated by keepTail
  process.env.FAKE_SSH_STDOUT = '\n__SEP__\n999999'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await read.execute({ file_path: '/f', offset: 1, limit: 10 * MiB }, exec)
    assert.ok(out.includes('of 999999'), `count survived truncation: ${out.slice(-120)}`)
  } finally {
    delete process.env.FAKE_SSH_BIG
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('write is atomic: base64 into a temp file, then mv -f over the target', async () => {
  const fake = await installFakeSsh()
  try {
    const r = await write.execute({ file_path: '/f', content: 'hello' }, exec)
    assert.match(r, /File written to remote host h: \/f/)
    const calls = await fake.readLog()
    const cmd = calls[calls.length - 1].at(-1)
    assert.match(cmd, /base64 -d > '\/f\.remote-ssh-tmp-[0-9a-f-]+'/, `temp-file decode: ${cmd}`)
    assert.match(cmd, /mv -f '\/f\.remote-ssh-tmp-[0-9a-f-]+' '\/f'/, `atomic rename: ${cmd}`)
    assert.match(cmd, /chmod --reference='\/f'/, `permission carry-over: ${cmd}`)
  } finally {
    await fake.cleanup()
  }
})

test('edit write-back carries the read-time mtime/size guard (TOCTOU)', async () => {
  const fake = await installFakeSsh()
  // every fake-ssh call answers the read probe: '<mtime> <size>' + base64('hello')
  process.env.FAKE_SSH_STDOUT = `1700000000 5\n${Buffer.from('hello').toString('base64')}\n`
  try {
    const r = await edit.execute({ file_path: '/f', old_string: 'hello', new_string: 'bye' }, exec)
    assert.match(r, /Edited remote host h: \/f/)
    const calls = await fake.readLog()
    assert.equal(calls.length, 2, 'one read + one guarded write-back')
    assert.match(calls[0].at(-1), /stat -c '%Y %s' -- '\/f'/, 'read probe stats the file')
    const writeBack = calls[1].at(-1)
    assert.match(writeBack, /\[ "\$\(stat -c '%Y %s' -- '\/f' 2>\/dev\/null\)" = '1700000000 5' \]/, `mtime/size guard: ${writeBack}`)
    assert.match(writeBack, /mv -f '\/f\.remote-ssh-tmp-[0-9a-f-]+' '\/f'/, `atomic rename: ${writeBack}`)
    assert.match(writeBack, /__REMOTE_SSH_CHANGED__/, 'TOCTOU marker present')
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    await fake.cleanup()
  }
})

test('edit reports a TOCTOU conflict with a re-read instruction', async () => {
  const fake = await installFakeSsh()
  // the read probe answers normally; the write-back (the call carrying mv)
  // fails the mtime/size guard with the marker on stderr
  process.env.FAKE_SSH_STDOUT = `1700000000 5\n${Buffer.from('hello').toString('base64')}\n`
  process.env.FAKE_SSH_FAIL_MATCH = 'mv -f'
  process.env.FAKE_SSH_FAIL_EXIT = '4'
  process.env.FAKE_SSH_FAIL_STDERR = '__REMOTE_SSH_CHANGED__: /f changed on the remote host during the edit'
  try {
    await assert.rejects(
      () => edit.execute({ file_path: '/f', old_string: 'hello', new_string: 'bye' }, exec),
      /changed on the remote host between read and write.*re-read/,
    )
    const calls = await fake.readLog()
    assert.equal(calls.length, 2, 'read probe + refused write-back')
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_FAIL_MATCH
    delete process.env.FAKE_SSH_FAIL_EXIT
    delete process.env.FAKE_SSH_FAIL_STDERR
    await fake.cleanup()
  }
})
