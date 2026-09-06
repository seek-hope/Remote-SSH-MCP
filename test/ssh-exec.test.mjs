import test from 'node:test'
import assert from 'node:assert/strict'
import { sshExec, keepTail } from '../src/ssh.js'
import { installFakeSsh } from './helpers.mjs'

const MiB = 1024 * 1024

test('keepTail bounds the buffer to cap and keeps the tail', () => {
  const chunks = []
  let total = 0
  for (const piece of ['abcdef', 'ghijkl', 'mnopqr']) {
    total = keepTail(chunks, total, Buffer.from(piece), 8)
  }
  assert.equal(total, 8)
  assert.equal(Buffer.concat(chunks).toString(), 'klmnopqr') // last 8 bytes of 'abcdefghijklmnopqr'
})

test('sshExec keeps the stdout tail and marks truncation', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_BIG = String(5 * MiB)
  process.env.FAKE_SSH_TAIL = 'ZZZ_TAIL'
  try {
    const out = await sshExec({ target: 'h', command: 'ignored', controlPersist: 0, maxStdout: 2048 })
    const text = out.toString('utf8')
    assert.ok(text.startsWith('[output truncated to last 2048 bytes]'), 'truncation marker present')
    assert.ok(text.endsWith('ZZZ_TAIL'), 'tail preserved')
    assert.ok(out.length <= 2048 + 64, `bounded (got ${out.length})`)
  } finally {
    delete process.env.FAKE_SSH_BIG
    delete process.env.FAKE_SSH_TAIL
    await fake.cleanup()
  }
})

test('sshExec surfaces the tail of a large stderr in the failure message', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_BIG_ERR = String(1 * MiB)
  process.env.FAKE_SSH_STDERR = '\nFINAL_ERROR_LINE\n'
  process.env.FAKE_SSH_EXIT = '1'
  try {
    await assert.rejects(
      () => sshExec({ target: 'h', command: 'ignored', controlPersist: 0 }),
      /FINAL_ERROR_LINE/,
    )
  } finally {
    delete process.env.FAKE_SSH_BIG_ERR
    delete process.env.FAKE_SSH_STDERR
    delete process.env.FAKE_SSH_EXIT
    await fake.cleanup()
  }
})
