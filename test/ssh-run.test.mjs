import test from 'node:test'
import assert from 'node:assert/strict'
import { connectTimeoutMs, resolveSshIdentity, sshExec, sshRun, sshSpawn } from '../src/ssh.js'
import { installLocalSsh } from './helpers.mjs'
import { parseTargets } from '../src/target.js'
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

test('a complete exit marker wins over a descendant-held channel timeout', async () => {
  const ssh = await installLocalSsh()
  try {
    const result = await sshRun({ target: 'h', command: 'sleep 2 & echo done', controlPersist: 0, timeoutMs: 300 })
    assert.equal(result.timedOut, false, 'the foreground command already finished')
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'done')
    assert.doesNotMatch(result.stdout, /__REMOTE_SSH_EXIT_/)
  } finally {
    await ssh.cleanup()
  }
})

test('sshRun decodes a no-marker tail across the carry boundary', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_SPLIT_OUTPUT = 'x'.repeat(12) + '😀' + 'y'.repeat(71)
  try {
    await assert.rejects(sshRun({ target: 'h', command: 'true', controlPersist: 0 }), (error) => {
      assert.match(error.message, /without exit marker/)
      assert.match(error.message, /😀/)
      assert.doesNotMatch(error.message, /\uFFFD/)
      return true
    })
  } finally {
    delete process.env.FAKE_SSH_SPLIT_OUTPUT
    await fake.cleanup()
  }
})

test('an out-of-range marker code is not accepted as the exit status', async () => {
  const fake = await installFakeSsh()
  try {
    for (const code of ['999', '1234']) {
      process.env.FAKE_SSH_MARK = code
      await assert.rejects(sshRun({ target: 'h', command: 'true', controlPersist: 0 }), /without exit marker/)
    }
  } finally {
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('sshRun never returns more than maxStdout bytes at a UTF-8 boundary', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_STDOUT = '😀'.repeat(20)
  process.env.FAKE_SSH_MARK = '0'
  try {
    for (const maxStdout of [3, 7, 10, 11]) {
      const result = await sshRun({ target: 'h', command: 'true', controlPersist: 0, maxStdout })
      assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= maxStdout,
        `byte cap ${maxStdout} (${Buffer.byteLength(result.stdout)})`)
      assert.doesNotMatch(result.stdout, /\uFFFD/)
    }
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('a complete marker survives a descendant that floods stdout after it', async () => {
  const ssh = await installLocalSsh()
  try {
    const result = await sshRun({
      target: 'h',
      command: '(sleep 0.1; yes B | head -c 5000000) & echo done',
      controlPersist: 0,
      timeoutMs: 500,
    })
    assert.equal(result.code, 0)
    assert.notEqual(result.timedOut, true)
    assert.equal(result.stdout, 'done', 'post-marker descendant output is discarded, not the marker')
  } finally {
    await ssh.cleanup()
  }
})

test('a complete marker is honored even when ssh exits non-zero afterwards', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  process.env.FAKE_SSH_EXIT = '255'
  process.env.FAKE_SSH_STDERR = 'Host key verification failed.\n'
  setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
  try {
    const result = await sshRun({ target: 'h', command: 'true', controlPersist: 0 })
    assert.equal(result.code, 0)
    assert.equal(result.timedOut, false)
    assert.equal(sudoCacheSize(), 1, 'a completed remote command is not a host-key failure')
  } finally {
    delete process.env.FAKE_SSH_MARK
    delete process.env.FAKE_SSH_EXIT
    delete process.env.FAKE_SSH_STDERR
    await fake.cleanup()
  }
})

test('wipeStdin wipes a large buffer even when the child never consumes it', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  const secret = Buffer.alloc(4 * 1024 * 1024, 0x41)
  try {
    const result = await sshRun({ target: 'h', command: 'true', stdin: secret, wipeStdin: true, timeoutMs: 5000 })
    assert.equal(result.code, 0)
    assert.equal(secret.every((byte) => byte === 0), true, 'the caller copy is wiped after an unconsumed/EPIPE stdin')

    const aborted = Buffer.from('TOPSECRET')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      sshRun({ target: 'h', command: 'true', stdin: aborted, wipeStdin: true, signal: controller.signal, controlPersist: 0 }),
      /aborted/,
    )
    assert.equal(aborted.every((byte) => byte === 0), true, 'an already-aborted call wipes the buffer')

    const oversized = Buffer.from('TOPSECRET')
    await assert.rejects(
      sshRun({ target: 'h', command: 'x'.repeat(200000), stdin: oversized, wipeStdin: true, controlPersist: 0 }),
      /too large/,
    )
    assert.equal(oversized.every((byte) => byte === 0), true, 'a spawn-time rejection wipes the buffer')
  } finally {
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('a command over the single-argument limit is rejected before spawning ssh', async () => {
  await assert.rejects(
    sshSpawn({ target: 'h', controlPersist: 0 }, 'x'.repeat(120_000)),
    /too large for one ssh argument/,
  )
  const spec = await sshSpawn({ target: 'h', controlPersist: 0 }, 'x'.repeat(60_000))
  assert.ok(Buffer.byteLength(spec.args.at(-1)) <= 96 * 1024)
  // Straddle the 96 KiB limit instead of only testing a far-below value.
  const near = await sshSpawn({ target: 'h', controlPersist: 0 }, 'x'.repeat(73_000))
  const nearBytes = Buffer.byteLength(near.args.at(-1))
  assert.ok(nearBytes > 96 * 1024 - 1024 && nearBytes <= 96 * 1024, `accepted just under the limit (${nearBytes})`)
  await assert.rejects(sshSpawn({ target: 'h', controlPersist: 0 }, 'x'.repeat(73_700)), /too large for one ssh argument/)
})

test('a successful command that prints a host-key phrase keeps the sudo cache', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_MARK = '0'
  process.env.FAKE_SSH_STDERR = 'Host key verification failed.\n'
  setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
  try {
    await sshExec({ target: 'h', command: 'true', controlPersist: 0 })
    const result = await sshRun({ target: 'h', command: 'true', controlPersist: 0 })
    assert.equal(result.code, 0)
    assert.equal(sudoCacheSize(), 1, 'successful output is not a host-key failure')
  } finally {
    delete process.env.FAKE_SSH_MARK
    delete process.env.FAKE_SSH_STDERR
    await fake.cleanup()
  }
})

test('host-key phrases only clear the cache on ssh exit 255, not remote exits, timeouts, or aborts', async () => {
  const fake = await installFakeSsh()
  const seed = () => setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
  try {
    process.env.FAKE_SSH_EXIT = '255'
    process.env.FAKE_SSH_STDERR = 'Host key verification failed.\n'
    seed()
    await assert.rejects(sshExec({ target: 'h', command: 'true', controlPersist: 0 }), /exit 255/)
    assert.equal(sudoCacheSize(), 0, 'a genuine ssh 255 host-key failure clears')

    process.env.FAKE_SSH_EXIT = '1'
    process.env.FAKE_SSH_STDERR = 'Host key verification failed.\nREAL_DETAIL\n'
    seed()
    await assert.rejects(sshExec({ target: 'h', command: 'true', controlPersist: 0 }), (error) => {
      assert.match(error.message, /exit 1/)
      assert.match(error.message, /REAL_DETAIL/, 'a non-255 exit keeps its real remote detail')
      return true
    })
    assert.equal(sudoCacheSize(), 1, 'a remote exit 1 is not an ssh client failure')

    process.env.FAKE_SSH_EXIT = '255'
    process.env.FAKE_SSH_HOLD_STDERR = '1'
    process.env.FAKE_SSH_STDERR = 'Host key verification failed.\n'
    seed()
    await assert.rejects(sshExec({ target: 'h', command: 'true', controlPersist: 0, timeoutMs: 300 }), /timeout/)
    assert.equal(sudoCacheSize(), 1, 'a timeout does not clear the cache')

    seed()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(
      sshExec({ target: 'h', command: 'true', controlPersist: 0, signal: controller.signal }),
      /aborted/,
    )
    assert.equal(sudoCacheSize(), 1, 'an abort does not clear the cache')

    // sshRun: a remote exit 1, timeout, and abort must also keep the cache.
    delete process.env.FAKE_SSH_HOLD_STDERR
    process.env.FAKE_SSH_EXIT = '1'
    seed()
    await assert.rejects(sshRun({ target: 'h', command: 'true', controlPersist: 0 }), /exit 1/)
    assert.equal(sudoCacheSize(), 1, 'sshRun remote exit 1 keeps the cache')

    process.env.FAKE_SSH_EXIT = '255'
    process.env.FAKE_SSH_HOLD_STDERR = '1'
    seed()
    const timed = await sshRun({ target: 'h', command: 'true', controlPersist: 0, timeoutMs: 300 })
    assert.equal(timed.timedOut, true)
    assert.equal(sudoCacheSize(), 1, 'sshRun timeout keeps the cache')

    seed()
    const controller2 = new AbortController()
    setTimeout(() => controller2.abort(), 100)
    await assert.rejects(
      sshRun({ target: 'h', command: 'true', controlPersist: 0, signal: controller2.signal }),
      /aborted/,
    )
    assert.equal(sudoCacheSize(), 1, 'sshRun abort keeps the cache')
  } finally {
    delete process.env.FAKE_SSH_EXIT
    delete process.env.FAKE_SSH_STDERR
    delete process.env.FAKE_SSH_HOLD_STDERR
    await fake.cleanup()
  }
})

test('a host-key phrase in the stderr head is found despite a stderr flood', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_HEAD_STDERR = 'Host key verification failed.\n'
  process.env.FAKE_SSH_BIG_ERR = String(200 * 1024)
  process.env.FAKE_SSH_EXIT = '255'
  setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
  try {
    await assert.rejects(sshExec({ target: 'h', command: 'true', controlPersist: 0 }), /exit 255.*host key verification failed/is)
    assert.equal(sudoCacheSize(), 0, 'the phrase in the retained head is detected and reported')
  } finally {
    delete process.env.FAKE_SSH_HEAD_STDERR
    delete process.env.FAKE_SSH_BIG_ERR
    delete process.env.FAKE_SSH_EXIT
    await fake.cleanup()
  }
})

test('the interactive connect timeout parses full numbers and falls back safely', () => {
  assert.equal(connectTimeoutMs(''), 150_000)
  assert.equal(connectTimeoutMs('0'), 150_000)
  assert.equal(connectTimeoutMs('-1'), 150_000)
  assert.equal(connectTimeoutMs('abc'), 150_000)
  assert.equal(connectTimeoutMs('1e5'), 100_000)
  assert.equal(connectTimeoutMs('999'), 1_000)
  assert.equal(connectTimeoutMs('999999'), 150_000)
  assert.equal(connectTimeoutMs('2000'), 2_000)
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
  process.env.FAKE_SSH_HOLD_STDERR = '1'
  const started = Date.now()
  try {
    const result = await sshRun({ target: 'h', command: 'true', timeoutMs: 300 })
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
  } finally {
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

test('a target ssh destination rejects unpaired surrogates', () => {
  assert.throws(() => parseTargets([{ ssh: 'h\ud800', root: '/' }]), /surrogate/)
  assert.throws(() => parseTargets([{ ssh: 'h', root: '/bad\ud800' }]), /surrogate/)
  assert.throws(() => parseTargets([{ ssh: 'h', name: 'bad\ud800', root: '/' }]), /surrogate/)
  // A hand-edited store may use null to mean "no override".
  assert.equal(parseTargets([{ ssh: 'h', root: '/', port: null }])[0].port, undefined)
})

test('resolveSshIdentity keeps a complete -G answer held open by a descendant', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'hold'
  const started = Date.now()
  try {
    const identity = await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 300 })
    assert.equal(identity, 'h\u0000testuser\u000022')
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 250 && elapsed < 1200, `the 300ms timeout path ran (${elapsed}ms)`)
})

test('resolveSshIdentity rejects a partial -G answer on timeout', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'partial'
  const started = Date.now()
  try {
    assert.equal(await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 300 }), undefined)
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 250 && elapsed < 1200, `the 300ms timeout path ran (${elapsed}ms)`)
})

test('resolveSshIdentity rejects a truncated final -G line on timeout', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'truncated'
  const started = Date.now()
  try {
    assert.equal(await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 300 }), undefined)
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 250 && elapsed < 1200, `the 300ms timeout path ran (${elapsed}ms)`)
})

test('resolveSshIdentity preserves UTF-8 split across output chunks', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'split-utf8'
  try {
    assert.equal(await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 2000 }), 'héllo\u0000usér\u000022')
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
})

test('resolveSshIdentity accepts a complete CRLF -G answer', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'crlf'
  try {
    const identity = await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 300 })
    assert.equal(identity, 'h\u0000testuser\u000022')
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
})

test('resolveSshIdentity rejects an answer without a user line on timeout', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'nouser'
  try {
    assert.equal(await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 300 }), undefined)
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
})

test('resolveSshIdentity rejects an incomplete answer that closes cleanly', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_G_MODE = 'nouser-close'
  const started = Date.now()
  try {
    // Long timeout: this must fail through the post-close completeness check,
    // not the timer.
    assert.equal(await resolveSshIdentity({ ssh: 'h' }, { timeoutMs: 5000 }), undefined)
  } finally {
    delete process.env.FAKE_SSH_G_MODE
    await fake.cleanup()
  }
  assert.ok(Date.now() - started < 2000, `the close path, not the 5s timer (${Date.now() - started}ms)`)
})
