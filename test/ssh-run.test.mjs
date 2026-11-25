import test from 'node:test'
import assert from 'node:assert/strict'
import { sshRun, sshSpawn } from '../src/ssh.js'
import { setCachedSudoPassword, sudoCacheKey, sudoCacheSize } from '../src/sudocache.js'
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
    assert.equal(r.stdoutTruncated, true)
    assert.equal(r.stderrTruncated, false)
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
    assert.equal(r.stderrTruncated, true)
    assert.equal(r.stdoutTruncated, false)
    assert.ok(/^E+$/.test(r.stderr), 'stderr is a suffix of the emitted bytes')
  } finally {
    delete process.env.FAKE_SSH_MARK
    delete process.env.FAKE_SSH_BIG_ERR
    await fake.cleanup()
  }
})

test('sshRun wipes a caller-provided stdin buffer when asked', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  const secret = Buffer.from('secret')
  try {
    const result = await sshRun({ target: 'h', command: 'true', stdin: secret, wipeStdin: true, timeoutMs: 5000 })
    assert.equal(result.code, 0)
  } finally {
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
  assert.equal(secret.every((byte) => byte === 0), true, 'the wire copy is wiped after stdin is accepted')
})

test('a command over the single-argument limit is rejected before spawning ssh', async () => {
  await assert.rejects(
    sshSpawn({ target: 'h', controlPersist: 0 }, 'x'.repeat(120_000)),
    /too large for one ssh argument/,
  )
  const spec = await sshSpawn({ target: 'h', controlPersist: 0 }, 'x'.repeat(60_000))
  assert.ok(Buffer.byteLength(spec.args.at(-1)) <= 96 * 1024)
})

test('a host-key failure clears the destination sudo cache', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_EXIT = '255'
  process.env.FAKE_SSH_STDERR = 'Host key verification failed.\n'
  setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
  try {
    await assert.rejects(sshRun({ target: 'h', command: 'true', timeoutMs: 5000 }), /ssh transport failed/)
    assert.equal(sudoCacheSize(), 0)
  } finally {
    delete process.env.FAKE_SSH_EXIT
    delete process.env.FAKE_SSH_STDERR
    await fake.cleanup()
  }
})

test('sshRun timeout settles even when a local descendant holds stderr', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  process.env.FAKE_SSH_HOLD_STDERR = '1'
  const started = Date.now()
  try {
    const result = await sshRun({ target: 'h', command: 'true', timeoutMs: 300 })
    assert.equal(result.timedOut, true)
  } finally {
    delete process.env.FAKE_SSH_MARK
    delete process.env.FAKE_SSH_HOLD_STDERR
    await fake.cleanup()
  }
  assert.ok(Date.now() - started < 2000, `sshRun settled after ${Date.now() - started}ms`)
})

test('the transport rejects NUL bytes and unpaired surrogates in a command', async () => {
  await assert.rejects(sshSpawn({ target: 'h', controlPersist: 0 }, 'echo \0'), /NUL/)
  await assert.rejects(sshSpawn({ target: 'h', controlPersist: 0 }, 'echo \ud800'), /surrogate/)
  const spec = await sshSpawn({ target: 'h', controlPersist: 0 }, 'echo 😀')
  assert.ok(spec.args.at(-1).includes('base64'))
})
