/**
 * store-lock.test.mjs — cross-process behavior of the target-store lock
 * (lock DIRECTORY + recovery gate protocol):
 *   - child-process RMW stress: 5 processes x 12 mutations = 60 locked
 *     read-modify-writes, none lost;
 *   - the required recovery properties: a live valid pid is NEVER stolen for
 *     age alone; an invalid/empty lock is broken only after the mtime grace;
 *     stale recovery cannot delete/move a fresh successor; an owner-write
 *     failure cleans its lock; release is token-checked;
 *   - dead-pid / corrupt / old-format locks are recovered, a live foreign
 *     lock times out intact, and the lock is released in finally;
 *   - the recovery gate obeys the same rules: a live recorded pid is never
 *     stolen for age, an ownerless gate gets its grace, a dead recoverer's
 *     gate is taken over, gate release is token-checked, acquirers back off
 *     before / wait after creating the lock, and stale recovery moves the
 *     lock aside by rename-to-trash (no residue on the shared path).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, utimes, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withStoreLock, readTargetStoreStrict as readTargetStore, saveTargetStore, _lockTestHooks } from '../src/store.js'

const STORE_URL = new URL('../src/store.js', import.meta.url).href
const OWNER = 'owner'

/** A pid that is guaranteed dead: start a child that exits immediately. */
async function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    child.on('exit', () => resolve(child.pid))
    child.on('error', reject)
  })
}

/** Spawn a live foreign process and a kill() cleanup for it. */
function liveForeignProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
  return { pid: child.pid, kill: () => new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGKILL') }) }
}

/** Seed a lock DIRECTORY whose owner record belongs to `record`. */
async function seedLock(file, record, { empty = false, ageMs = 0 } = {}) {
  const lockPath = `${file}.lock`
  await mkdir(lockPath, { recursive: true })
  if (!empty) await writeFile(join(lockPath, OWNER), `${JSON.stringify(record)}\n`, 'utf8')
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs)
    await utimes(lockPath, past, past)
  }
  return lockPath
}

async function readOwner(lockPath) {
  return JSON.parse(await readFile(join(lockPath, OWNER), 'utf8'))
}

/** Seed a recovery-gate DIRECTORY whose owner record belongs to `record`. */
async function seedGate(file, record, { empty = false, ageMs = 0 } = {}) {
  const gatePath = `${file}.lock.recover`
  await mkdir(gatePath, { recursive: true })
  if (!empty) await writeFile(join(gatePath, OWNER), `${JSON.stringify(record)}\n`, 'utf8')
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs)
    await utimes(gatePath, past, past)
  }
  return gatePath
}

/** Leftover lock/gate/trash artifacts in a store dir. */
async function lockArtifacts(dir) {
  return (await readdir(dir)).filter((n) => n.endsWith('.lock') || n.endsWith('.recover') || n.includes('.trash'))
}

/**
 * Run one worker process that performs `count` locked read-modify-write adds,
 * each re-reading under the lock with a random delay inside the critical
 * section to maximize interleaving pressure.
 */
function spawnWorker(file, id, count) {
  const worker = `
import { withStoreLock, readTargetStoreStrict as readTargetStore, saveTargetStore } from ${JSON.stringify(STORE_URL)}
const [file, id, count] = process.argv.slice(2)
for (let i = 0; i < Number(count); i++) {
  await withStoreLock(file, async () => {
    const cur = await readTargetStore(file)
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)))
    cur.push({ name: 'w' + id + '-' + i, ssh: 'host' + id, root: '/r' })
    await saveTargetStore(file, cur)
  }, { timeoutMs: 20000, graceMs: 1000, retryMs: 5 })
}
process.stdout.write('ok')
`
  return new Promise((resolve, reject) => {
    // `node -e <script>` puts extra args at argv[1..]; the leading placeholder
    // keeps file/id/count aligned at argv.slice(2) across node versions.
    const child = spawn(process.execPath, ['-e', worker, 'placeholder', file, String(id), String(count)])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`worker ${id} exited ${code}: ${err}`)))
  })
}

test('withStoreLock serializes read-modify-write across CHILD PROCESSES: 60 mutations, none lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-xproc-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  // 5 processes x 12 mutations each (>= 50 total); every mutation re-reads
  // under the lock, with randomized in-lock delays to force interleaving.
  await Promise.all(Array.from({ length: 5 }, (_, w) => spawnWorker(file, w, 12)))
  const final = await readTargetStore(file)
  assert.equal(final.length, 60, `expected 60 targets, got ${final.length}`)
  assert.equal(new Set(final.map((t) => t.name)).size, 60, 'every mutation must survive')
  assert.deepEqual(await lockArtifacts(dir), [], 'no lock/gate artifacts left behind')
  await rm(dir, { recursive: true, force: true })
})

test('a burst of concurrent in-process acquirers keeps every critical section atomic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-burst-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  let counter = 0
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  await Promise.all(Array.from({ length: 12 }, () =>
    withStoreLock(file, async () => {
      const cur = await readTargetStore(file)
      const seen = cur.length
      await delay(Math.random() * 5)
      cur.push({ name: `t${seen}`, ssh: 'h', root: '/r' }) // name derived from the read: duplicates prove a lost update
      await saveTargetStore(file, cur)
      counter++
    }, { graceMs: 1000 }),
  ))
  assert.equal(counter, 12)
  const final = await readTargetStore(file)
  assert.equal(final.length, 12)
  assert.equal(new Set(final.map((t) => t.name)).size, 12, 'no lost update under concurrency')
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('a lock whose owner pid is DEAD is recovered instead of blocking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-dead-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const ghost = await deadPid()
  await seedLock(file, { token: 'ghost.was-here', pid: ghost, at: new Date().toISOString() })
  const t0 = Date.now()
  await withStoreLock(file, async () => {
    const cur = await readTargetStore(file)
    cur.push({ name: 'recovered', ssh: 'h', root: '/r' })
    await saveTargetStore(file, cur)
  }, { timeoutMs: 5000, graceMs: 60_000, retryMs: 5 })
  assert.ok(Date.now() - t0 < 4000, 'dead-owner lock must be recovered quickly')
  assert.equal((await readTargetStore(file)).length, 1)
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('a lock with a LIVE valid pid is NEVER stolen for age alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-livepid-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const foreign = liveForeignProcess()
  try {
    const lockPath = await seedLock(
      file,
      { token: 'wedged.holder', pid: foreign.pid, at: '2020-01-01T00:00:00Z' },
      { ageMs: 10 * 60_000 }, // mtime far older than any grace: age must not matter
    )
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 400, graceMs: 100, retryMs: 25 }),
      /timed out.*target-store lock/,
    )
    // The live holder's owner record was never touched by our failed acquisition.
    const rec = await readOwner(lockPath)
    assert.equal(rec.token, 'wedged.holder')
    assert.equal(rec.pid, foreign.pid)
  } finally {
    await foreign.kill()
  }
  await rm(dir, { recursive: true, force: true })
})

test('an EMPTY/invalid lock is only broken after the mtime grace (in-flight creates are safe)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-grace-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  // Fresh empty lock dir = a create that is mid-flight (mkdir done, owner
  // write pending): within the grace it must NOT be broken.
  const lockPath = await seedLock(file, {}, { empty: true })
  await assert.rejects(
    () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 400, graceMs: 60_000, retryMs: 25 }),
    /timed out.*target-store lock/,
  )
  await assert.rejects(() => readFile(join(lockPath, OWNER), 'utf8'), /ENOENT/, 'fresh empty lock left untouched (still empty)')
  // Once the same empty lock ages past the grace, it is recovered.
  const past = new Date(Date.now() - 10_000)
  await utimes(lockPath, past, past)
  await withStoreLock(file, async () => {}, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 })
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('a CORRUPT (unparsable) owner record is recovered once past the grace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-corrupt-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const lockPath = `${file}.lock`
  await mkdir(lockPath)
  await writeFile(join(lockPath, OWNER), 'not json at all', 'utf8')
  const past = new Date(Date.now() - 10_000)
  await utimes(lockPath, past, past)
  await withStoreLock(file, async () => {}, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 })
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('a stale recovery cannot delete or move a FRESH SUCCESSOR lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-successor-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const lockPath = `${file}.lock`
  const ghost = await deadPid()
  await seedLock(file, { token: 'ghost.stale', pid: ghost }, { ageMs: 60_000 })
  const foreign = liveForeignProcess()
  try {
    // While the recoverer is under its gate (lock judged stale, break
    // imminent), a fresh successor acquires the lock. The gate protocol must
    // re-judge and back off instead of removing the successor.
    let swapped = false
    _lockTestHooks.onGateEntered = async () => {
      if (swapped) return
      swapped = true
      await writeFile(join(lockPath, OWNER), `${JSON.stringify({ token: 'successor.fresh', pid: foreign.pid, at: new Date().toISOString() })}\n`, 'utf8')
    }
    try {
      await assert.rejects(
        () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 600, graceMs: 100, retryMs: 25 }),
        /timed out.*target-store lock/,
        'the contender must wait on the fresh successor, not steal it',
      )
    } finally {
      delete _lockTestHooks.onGateEntered
    }
    assert.ok(swapped, 'the recovery gate must have been entered')
    const rec = await readOwner(lockPath)
    assert.equal(rec.token, 'successor.fresh', 'the fresh successor lock must be intact')
    assert.equal(rec.pid, foreign.pid)
    assert.deepEqual((await lockArtifacts(dir)).filter((n) => n.endsWith('.recover')), [], 'gate released')
  } finally {
    await foreign.kill()
    await rm(lockPath, { recursive: true, force: true }).catch(() => {})
  }
  // Control: the same stale lock without a successor is recovered normally.
  await withStoreLock(file, async () => {}, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 })
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('an owner-write failure cleans its lock and surfaces the error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-ownwrite-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  _lockTestHooks.writeOwner = async () => {
    const e = new Error('injected EIO')
    e.code = 'EIO'
    throw e
  }
  try {
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 2000, graceMs: 500, retryMs: 5 }),
      /injected EIO/,
    )
  } finally {
    delete _lockTestHooks.writeOwner
  }
  assert.deepEqual(await lockArtifacts(dir), [], 'the empty lock husk must be cleaned up')
  // And the next acquisition works normally.
  const value = await withStoreLock(file, async () => 42, { timeoutMs: 5000, graceMs: 500, retryMs: 5 })
  assert.equal(value, 42)
  await rm(dir, { recursive: true, force: true })
})

test('release is token-checked: a successor owner record survives our release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-release-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const lockPath = `${file}.lock`
  await withStoreLock(file, async () => {
    // Simulate a successor having taken over the (directory) lock while we
    // held it: our token is no longer the one on disk.
    await writeFile(join(lockPath, OWNER), `${JSON.stringify({ token: 'successor.token', pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8')
  }, { timeoutMs: 5000, graceMs: 60_000, retryMs: 5 })
  const rec = await readOwner(lockPath)
  assert.equal(rec.token, 'successor.token', 'release must not delete a lock it no longer owns')
  await rm(lockPath, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

test('a LIVE foreign lock times out (bounded wait), stays intact, and works again after release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-live-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const foreign = liveForeignProcess()
  try {
    const lockPath = await seedLock(file, { token: 'foreign.holder', pid: foreign.pid, at: new Date().toISOString() })
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 300, graceMs: 60_000, retryMs: 25 }),
      /timed out.*target-store lock/,
    )
    // The live holder's lock was never destroyed by our failed acquisition.
    const rec = await readOwner(lockPath)
    assert.equal(rec.token, 'foreign.holder')
  } finally {
    await foreign.kill()
  }
  // Once the foreign lock is gone, acquisition works again.
  await withStoreLock(file, async () => {}, { timeoutMs: 5000, graceMs: 60_000, retryMs: 5 })
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('a plain-file lock from an older plugin version is recovered (self-heal)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-oldfmt-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const lockPath = `${file}.lock`
  await writeFile(lockPath, `${JSON.stringify({ owner: 'old.format', pid: 1, at: '2020-01-01T00:00:00Z' })}\n`, 'utf8')
  const past = new Date(Date.now() - 10_000)
  await utimes(lockPath, past, past)
  await withStoreLock(file, async () => {}, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 })
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('the lock is released in finally even when fn throws or times out waiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-finally-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  await assert.rejects(
    () => withStoreLock(file, async () => { throw new Error('boom') }, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 }),
    /boom/,
  )
  assert.deepEqual(await lockArtifacts(dir), [], 'lock removed after fn throws')
  // And the next acquisition is not blocked by the leaked lock.
  const value = await withStoreLock(file, async () => 42, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 })
  assert.equal(value, 42)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Recovery-gate protocol: the gate obeys the same rules as the lock itself.
// ---------------------------------------------------------------------------

test('a recovery GATE whose recorded pid is LIVE is never stolen for age alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gatelive-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const ghost = await deadPid()
  const lockPath = await seedLock(file, { token: 'ghost.stale', pid: ghost }, { ageMs: 60_000 })
  const foreign = liveForeignProcess()
  try {
    const gatePath = await seedGate(
      file,
      { token: 'wedged.recoverer', pid: foreign.pid },
      { ageMs: 10 * 60_000 }, // far older than GATE_STALE_MS: age must not matter
    )
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 400, graceMs: 100, retryMs: 25 }),
      /timed out.*target-store lock/,
    )
    const rec = await readOwner(gatePath)
    assert.equal(rec.token, 'wedged.recoverer', 'the live recoverer\'s gate was never touched')
    assert.equal(rec.pid, foreign.pid)
    const lockRec = await readOwner(lockPath)
    assert.equal(lockRec.token, 'ghost.stale', 'no recovery ran under someone else\'s live gate')
  } finally {
    await foreign.kill()
  }
  await rm(dir, { recursive: true, force: true })
})

test('an OWNERLESS recovery gate gets its grace; once aged it is taken over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gategrace-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const ghost = await deadPid()
  await seedLock(file, { token: 'ghost.stale', pid: ghost }, { ageMs: 60_000 })
  // Fresh empty gate dir = a recoverer that crashed between mkdir and the
  // owner write (or is mid-write): within the grace it must NOT be stolen.
  const gatePath = await seedGate(file, {}, { empty: true })
  await assert.rejects(
    () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 400, graceMs: 100, retryMs: 25 }),
    /timed out.*target-store lock/,
  )
  await assert.rejects(() => readFile(join(gatePath, OWNER), 'utf8'), /ENOENT/, 'fresh ownerless gate left untouched')
  // Once it ages past GATE_STALE_MS, it is taken over and the stale lock
  // behind it is recovered normally — no artifacts, no trash residue.
  const past = new Date(Date.now() - 10 * 60_000)
  await utimes(gatePath, past, past)
  await withStoreLock(file, async () => {}, { timeoutMs: 5000, graceMs: 1000, retryMs: 5 })
  assert.deepEqual(await lockArtifacts(dir), [])
  await rm(dir, { recursive: true, force: true })
})

test('a recovery GATE with a DEAD owner is taken over immediately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gatedead-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const ghost = await deadPid()
  await seedLock(file, { token: 'ghost.stale', pid: ghost }, { ageMs: 60_000 })
  await seedGate(file, { token: 'dead.recoverer', pid: ghost })
  const t0 = Date.now()
  await withStoreLock(file, async () => {
    const cur = await readTargetStore(file)
    cur.push({ name: 'recovered', ssh: 'h', root: '/r' })
    await saveTargetStore(file, cur)
  }, { timeoutMs: 5000, graceMs: 60_000, retryMs: 5 })
  assert.ok(Date.now() - t0 < 4000, 'a dead recoverer\'s gate must not block')
  assert.equal((await readTargetStore(file)).length, 1)
  assert.deepEqual(await lockArtifacts(dir), [], 'gate + lock cleaned up, no trash residue')
  await rm(dir, { recursive: true, force: true })
})

test('GATE release is token-checked: a foreign gate survives our recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gatetoken-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const ghost = await deadPid()
  const lockPath = await seedLock(file, { token: 'ghost.stale', pid: ghost }, { ageMs: 60_000 })
  const gatePath = `${file}.lock.recover`
  _lockTestHooks.onGateEntered = async () => {
    // Simulate another breaker having taken the gate over while we worked:
    // the record on disk is no longer ours.
    await writeFile(join(gatePath, OWNER), `${JSON.stringify({ token: 'foreign.recoverer', pid: process.pid })}\n`, 'utf8')
  }
  try {
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 600, graceMs: 100, retryMs: 25 }),
      /timed out.*target-store lock/,
      'the contender must back off behind the live foreign gate',
    )
  } finally {
    delete _lockTestHooks.onGateEntered
  }
  const rec = await readOwner(gatePath)
  assert.equal(rec.token, 'foreign.recoverer', 'release must not delete a gate it no longer owns')
  await assert.rejects(() => readOwner(lockPath), /ENOENT/, 'the genuinely stale lock was still recovered')
  await rm(gatePath, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

test('an acquirer backs off BEFORE creating the lock while a live gate stands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gatepre-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  const foreign = liveForeignProcess()
  try {
    // No main lock exists at all — only a live recovery gate. Creating the
    // lock underneath an in-flight verdict could get it renamed away after
    // the fact, so the acquirer must wait instead of creating.
    await seedGate(file, { token: 'busy.recoverer', pid: foreign.pid })
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 400, graceMs: 100, retryMs: 25 }),
      /timed out.*target-store lock/,
    )
    const names = await readdir(dir)
    assert.ok(!names.includes('targets.json.lock'), 'no lock was created under a live recovery gate')
    const rec = await readOwner(`${file}.lock.recover`)
    assert.equal(rec.token, 'busy.recoverer', 'the gate was never touched either')
  } finally {
    await foreign.kill()
  }
  await rm(dir, { recursive: true, force: true })
})

test('an acquirer waits out a gate that appears around its create, then confirms its token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gatepost-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  let armed = false
  _lockTestHooks.writeOwner = async (lockPath, token) => {
    if (armed) return
    armed = true
    // The real owner write, then a recovery gate springs up right after our
    // record lands but before the acquirer can trust the lock.
    await writeFile(join(lockPath, OWNER), `${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8')
    const gatePath = `${lockPath}.recover`
    await mkdir(gatePath)
    await writeFile(join(gatePath, OWNER), `${JSON.stringify({ token: 'slow.recoverer', pid: process.pid })}\n`, 'utf8')
    setTimeout(() => { rm(gatePath, { recursive: true, force: true }).catch(() => {}) }, 60)
  }
  try {
    const value = await withStoreLock(file, async () => 'ran', { timeoutMs: 5000, graceMs: 1000, retryMs: 10 })
    assert.equal(value, 'ran', 'acquisition succeeded once the transient gate cleared and the token re-checked')
    assert.ok(armed, 'the create actually went through the instrumented owner write')
  } finally {
    delete _lockTestHooks.writeOwner
  }
  assert.deepEqual(await lockArtifacts(dir), [], 'released cleanly afterwards')
  await rm(dir, { recursive: true, force: true })
})

test('a WEDGED live gate bounds even a verified acquisition (own verified lock given up)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-gatewedge-'))
  const file = join(dir, 'targets.json')
  await saveTargetStore(file, [])
  let armed = false
  _lockTestHooks.writeOwner = async (lockPath, token) => {
    if (armed) return
    armed = true
    await writeFile(join(lockPath, OWNER), `${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8')
    // A gate whose holder never finishes: the bounded wait must win.
    const gatePath = `${lockPath}.recover`
    await mkdir(gatePath)
    await writeFile(join(gatePath, OWNER), `${JSON.stringify({ token: 'wedged.recoverer', pid: process.pid })}\n`, 'utf8')
  }
  try {
    await assert.rejects(
      () => withStoreLock(file, async () => assert.fail('must not run'), { timeoutMs: 500, graceMs: 1000, retryMs: 20 }),
      /timed out.*target-store lock/,
    )
  } finally {
    delete _lockTestHooks.writeOwner
  }
  const names = await readdir(dir)
  assert.ok(!names.includes('targets.json.lock'), 'our own verified lock was released on the way out, not leaked')
  await rm(`${file}.lock.recover`, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})
