/**
 * lock.js — cross-process locking for the target store (Node stdlib only).
 *
 * Mutations go through withStoreLock, which is safe across PROCESSES: the
 * lock is the DIRECTORY `<store>.lock` (atomic mkdir on POSIX and Windows)
 * holding an `owner` record (random token + pid). Recovery of a dead holder's
 * lock follows a gate protocol:
 *
 *   - A lock with a valid owner record whose pid is ALIVE is never broken,
 *     no matter how old it is (a wedged holder surfaces as a bounded-wait
 *     timeout instead of a stolen lock).
 *   - A lock with no valid record (crash between mkdir and the owner write)
 *     is broken only after a short mtime grace that absorbs in-flight
 *     creates; an acquirer re-reads the owner record after writing it and
 *     backs off unless its own token is on disk, so a lock removed under an
 *     in-flight create is retried, never double-held.
 *   - Breaking happens under the recovery gate `<store>.lock.recover`, which
 *     follows the same rules as the lock itself: a gate whose recorded pid is
 *     ALIVE is never stolen for age, an ownerless gate (crash between mkdir
 *     and the record write) only after GATE_STALE_MS, a dead recoverer's
 *     gate immediately. Acquirers stay out of an in-flight recovery — they
 *     back off while a live gate exists before creating the lock, and after
 *     creating theirs they wait any gate out and re-confirm their token — so
 *     a recovery verdict can never land on a lock created afterwards. Under
 *     the gate the lock is RE-inspected (so stale recovery can never delete
 *     or move a fresh successor) and a still-stale lock is moved aside by
 *     ATOMIC RENAME to a unique trash name inside the gate; the recursive
 *     cleanup runs on that copy, never on the shared main path, and a
 *     crashed cleanup is swept away with the gate itself.
 *   - Release is token-checked for the lock AND the gate: a holder removes
 *     either only when its own token is still the one on disk.
 *
 * On top of this sits the per-process promise queue that keeps same-process
 * writers ordered.
 */

import { readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'


/**
 * Per-store-file mutation queue. add/update/remove each do a read-modify-write
 * on the store; serializing them on this queue (keyed by file path) prevents
 * concurrent writers in ONE process from clobbering each other's updates.
 * Cross-process exclusion is layered underneath it in withStoreLock.
 */
const storeQueues = new Map()

// ---------------------------------------------------------------------------
// Cross-process lock (Node stdlib only: atomic mkdir + owner record + gate).
// ---------------------------------------------------------------------------

/** Positive integer from an env var, or the fallback. Test/ops tuning knob. */
function numEnv(name, fallback) {
  const v = Number.parseInt(process.env[name], 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * Lock tuning for one withStoreLock call. Defaults: the acquire wait
 * (timeoutMs) must cover the worst legal in-lock work — an update's ssh
 * verification is 25s + 25s probes plus a 30s remote mkdir (~80s), so the
 * default sits well above it at 150s. graceMs is the mtime grace that
 * protects an empty/in-flight lock create from being broken too early.
 */
function lockOpts(opts = {}) {
  return {
    timeoutMs: opts.timeoutMs ?? numEnv('REMOTE_SSH_LOCK_TIMEOUT_MS', 150_000),
    graceMs: opts.graceMs ?? numEnv('REMOTE_SSH_LOCK_GRACE_MS', 5_000),
    retryMs: opts.retryMs ?? numEnv('REMOTE_SSH_LOCK_RETRY_MS', 50),
  }
}

/**
 * Grace for an OWNERLESS recovery gate (a crash between mkdir and the owner
 * write): taken over only once older than this. A gate whose record holds a
 * LIVE pid is never stolen for age at all.
 */
const GATE_STALE_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lockPathFor = (file) => `${file}.lock`
const gatePathFor = (file) => `${file}.lock.recover`
const ownerPathFor = (lockPath) => join(lockPath, 'owner')

/**
 * Test-only seams for store-lock.test.mjs (deterministic fault/race
 * injection). Never set in production code.
 */
export const _lockTestHooks = {}

/** Liveness probe for a pid (signal 0 checks existence only). */
function pidAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM' // exists but owned by someone else
  }
}

function ownerRecord(token) {
  return `${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })}\n`
}

async function writeOwnerRecord(lockPath, token) {
  await writeFile(ownerPathFor(lockPath), ownerRecord(token), 'utf8')
}

/**
 * Read a lock directory's owner record; undefined when missing, unparsable,
 * or not shaped like one (an empty husk from a crash between mkdir and the
 * owner write, a foreign file, or a plain file left by an older plugin
 * version).
 */
async function readOwnerRecord(lockPath) {
  try {
    const rec = JSON.parse(await readFile(ownerPathFor(lockPath), 'utf8'))
    if (rec && typeof rec.token === 'string' && rec.token.length > 0) return rec
  } catch { /* fall through */ }
  return undefined
}

/**
 * Judge the existing lock at lockPath:
 *   'gone'   — vanished since we looked; just retry the create.
 *   'held'   — do not touch: either a valid record with a LIVE pid (never
 *              stolen, whatever its age) or no valid record yet but young
 *              enough to be an in-flight create (within graceMs).
 *   'stale'  — safe to recover under the gate: a valid record whose pid is
 *              dead, or no valid record and older than graceMs.
 */
async function judgeLock(lockPath, graceMs) {
  const rec = await readOwnerRecord(lockPath)
  if (rec !== undefined) {
    return Number.isInteger(rec.pid) && pidAlive(rec.pid) ? 'held' : 'stale'
  }
  let mtimeMs
  try {
    ;({ mtimeMs } = await stat(lockPath))
  } catch {
    return 'gone'
  }
  return Date.now() - mtimeMs > graceMs ? 'stale' : 'held'
}

/**
 * Judge the recovery gate at gatePath: true while a live recoverer may hold
 * it — a valid owner record with a LIVE pid (never stealable, whatever its
 * age), or an ownerless husk that may be a create mid-flight (within the
 * GATE_STALE_MS grace). False for no gate, a dead recoverer's gate, or an
 * ownerless husk past its grace.
 */
async function gateLive(gatePath) {
  const g = await readOwnerRecord(gatePath)
  if (g !== undefined) return Number.isInteger(g.pid) && pidAlive(g.pid)
  try {
    return Date.now() - (await stat(gatePath)).mtimeMs <= GATE_STALE_MS
  } catch {
    return false // vanished mid-check
  }
}

/**
 * Take the recovery gate: serializes concurrent recoverers. A gate whose
 * recorded pid is LIVE is never stolen — whatever its age (a wedged
 * recoverer surfaces as the acquirer's bounded-wait timeout instead); a DEAD
 * recoverer's gate is taken over immediately; an ownerless one only after
 * GATE_STALE_MS. Takeover renames the old gate to a unique trash name
 * (atomic: no half-removed gate is ever visible) before recreating ours.
 * @returns {Promise<boolean>} true when WE now hold the gate
 */
async function enterGate(gatePath) {
  try {
    await mkdir(gatePath)
    return true
  } catch (e) {
    if (e?.code !== 'EEXIST') return false // e.g. EACCES: leave recovery to others
  }
  if (await gateLive(gatePath)) return false // another live recoverer owns the gate
  const trash = `${gatePath}.${process.pid}.${randomUUID()}.trash`
  try {
    await rename(gatePath, trash)
  } catch {
    return false // another breaker moved/won it; let it proceed
  }
  await rm(trash, { recursive: true, force: true }).catch(() => {})
  try {
    await mkdir(gatePath)
    return true
  } catch {
    return false // another breaker won the gate; let it proceed
  }
}

/**
 * Release the gate — only when our own token is still the one on disk
 * (never delete a successor's gate).
 */
async function releaseGate(gatePath, token) {
  try {
    const g = await readOwnerRecord(gatePath)
    if (g?.token === token) {
      await rm(gatePath, { recursive: true, force: true })
    }
  } catch { /* best effort: takeover rules cover a leaked gate */ }
}

/**
 * Break a lock already judged stale — under the recovery gate. The gate
 * freezes the lock while we RE-judge it: between the contended inspection
 * and this point an in-flight create may have completed into a valid live
 * lock, which we must leave alone. Only a lock that is still stale under the
 * gate is recovered — by ATOMIC RENAME to a unique trash name inside the
 * gate we hold, so the shared main path never sees a partial removal — and
 * the recursive cleanup runs on that copy off to the side; a crashed cleanup
 * is swept away together with the gate by the next takeover.
 */
async function recoverLock(lockPath, gatePath, token, graceMs) {
  if (!(await enterGate(gatePath))) return
  try {
    await writeOwnerRecord(gatePath, token).catch(() => {}) // best effort: enables gate takeover
    await _lockTestHooks.onGateEntered?.(lockPath) // test-only race-injection seam
    if (await judgeLock(lockPath, graceMs) === 'stale') {
      const trash = join(gatePath, `victim.${process.pid}.${randomUUID()}`)
      try {
        await rename(lockPath, trash)
      } catch {
        return // vanished since the verdict; nothing to clean
      }
      await rm(trash, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    await releaseGate(gatePath, token)
  }
}

/**
 * Acquire the cross-process lock: atomic mkdir of the lock directory, owner
 * record write, and a read-back check that closes the create-vs-recovery
 * window (a recoverer that judged our empty in-flight lock stale must leave
 * us retrying — never holding a lock that was removed underneath us).
 * Acquirers also stay clear of an in-flight recovery: while a live recovery
 * gate exists they do not even attempt the create (its verdict may predate
 * our owner record), and after a successful create they wait any gate out
 * and re-confirm their token before trusting the lock.
 * @returns {Promise<{ lockPath: string, token: string }>}
 */
async function acquireStoreLock(file, opts) {
  const lockPath = lockPathFor(file)
  const gatePath = gatePathFor(file)
  const token = `${process.pid}.${randomUUID()}`
  const deadline = Date.now() + opts.timeoutMs
  const timedOut = () => new Error(`timed out after ${opts.timeoutMs}ms waiting for the target-store lock ${lockPath} (held by another process)`)
  for (;;) {
    let created = false
    // A live recovery gate owns the next move on the lock: don't create it,
    // and don't start a competing recovery underneath an in-flight verdict.
    // Dead/aged gates fall through so the recovery below can take them over.
    if (!(await gateLive(gatePath))) {
      try {
        await mkdir(lockPath)
        created = true
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e // e.g. EACCES: not a contention problem
      }
      if (created) {
        try {
          await (_lockTestHooks.writeOwner ?? writeOwnerRecord)(lockPath, token)
        } catch (e) {
          if (e?.code !== 'ENOENT') {
            // Owner-write failure: clean up our empty lock so nobody waits on a
            // husk, then surface the error (the mutation can be retried).
            await rm(lockPath, { recursive: true, force: true }).catch(() => {})
            throw e
          }
          // ENOENT: the lock dir vanished under us (another process recovered
          // it mid-create) — not ours; fall through to the retry below.
        }
        const rec = await readOwnerRecord(lockPath)
        if (rec?.token === token) {
          // A gate that appeared around our create may hold a verdict taken
          // BEFORE our owner record landed; wait it out, then re-confirm our
          // token is still on disk before trusting the lock.
          while (await gateLive(gatePath)) {
            if (Date.now() >= deadline) {
              await releaseStoreLock({ lockPath, token }) // don't leak our own verified lock
              throw timedOut()
            }
            await sleep(opts.retryMs)
          }
          const confirmed = await readOwnerRecord(lockPath)
          if (confirmed?.token === token) return { lockPath, token }
        }
      } else {
        if (await judgeLock(lockPath, opts.graceMs) === 'stale') {
          await recoverLock(lockPath, gatePath, token, opts.graceMs)
        }
      }
    }
    if (Date.now() >= deadline) {
      throw timedOut()
    }
    await sleep(opts.retryMs)
  }
}

/**
 * Release the lock — only when our own token is still the one on disk
 * (never delete a successor's lock).
 */
async function releaseStoreLock(handle) {
  if (handle === undefined) return
  try {
    const rec = await readOwnerRecord(handle.lockPath)
    if (rec?.token === handle.token) {
      await rm(handle.lockPath, { recursive: true, force: true })
    }
  } catch { /* best effort: stale recovery covers a leaked lock */ }
}

/**
 * Run `fn` exclusively against `file`. Same-process callers are serialized on
 * a promise queue (cheap, preserves ordering); the queued run then takes the
 * cross-process `<file>.lock` DIRECTORY, so writers in different MCP
 * processes cannot interleave their
 * read-modify-writes either. `fn` MUST re-read the store under the lock —
 * manage-core does, strictly. Resolves/rejects with fn's own result; the lock
 * is always released.
 * @param {string} file
 * @param {() => Promise<T>} fn
 * @param {{ timeoutMs?: number, graceMs?: number, retryMs?: number }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export function withStoreLock(file, fn, opts) {
  const prev = storeQueues.get(file) ?? Promise.resolve()
  const run = prev.then(async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const lockOpts_ = lockOpts(opts)
    const handle = await acquireStoreLock(file, lockOpts_)
    try {
      return await fn()
    } finally {
      await releaseStoreLock(handle)
    }
  })
  const tail = run.then(() => {}, () => {}) // never rejects; keep the queue alive
  storeQueues.set(file, tail)
  tail.then(() => { if (storeQueues.get(file) === tail) storeQueues.delete(file) })
  return run
}
