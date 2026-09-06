import test from 'node:test'
import assert from 'node:assert/strict'
import { sshRun } from '../src/ssh.js'
import { installFakeSsh } from './helpers.mjs'

const MiB = 1024 * 1024

test('sshRun keeps the exit code for >4MiB output (default maxStdout)', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_BIG = String(5 * MiB)
  process.env.FAKE_SSH_TAIL = 'ZZZ_TAIL'
  process.env.FAKE_SSH_MARK = '7'
  try {
    const r = await sshRun({ target: 'h', command: 'ignored', controlPersist: 0 })
    assert.equal(r.code, 7)
    assert.ok(r.stdout.endsWith('ZZZ_TAIL'), 'tail must be preserved')
    assert.ok(r.stdout.length <= 4 * MiB, 'stdout must be bounded')
  } finally {
    delete process.env.FAKE_SSH_BIG
    delete process.env.FAKE_SSH_TAIL
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('sshRun with small maxStdout keeps the tail and the exit code', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_BIG = String(5 * MiB)
  process.env.FAKE_SSH_TAIL = 'ZZZ_TAIL'
  process.env.FAKE_SSH_MARK = '3'
  try {
    const r = await sshRun({ target: 'h', command: 'ignored', controlPersist: 0, maxStdout: 2048 })
    assert.equal(r.code, 3)
    assert.ok(r.stdout.endsWith('ZZZ_TAIL'), 'tail must be preserved')
    assert.ok(r.stdout.length <= 2048, `stdout bounded (got ${r.stdout.length})`)
    assert.ok(/^A+ZZZ_TAIL$/.test(r.stdout), 'stdout is a suffix of the emitted payload')
  } finally {
    delete process.env.FAKE_SSH_BIG
    delete process.env.FAKE_SSH_TAIL
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('sshRun caps stderr memory', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  process.env.FAKE_SSH_BIG_ERR = String(1 * MiB)
  try {
    const r = await sshRun({ target: 'h', command: 'ignored', controlPersist: 0, maxStderr: 4096 })
    assert.equal(r.code, 0)
    assert.equal(r.stderr.length, 4096)
    assert.ok(/^E+$/.test(r.stderr), 'stderr is a suffix of the emitted bytes')
  } finally {
    delete process.env.FAKE_SSH_MARK
    delete process.env.FAKE_SSH_BIG_ERR
    await fake.cleanup()
  }
})
