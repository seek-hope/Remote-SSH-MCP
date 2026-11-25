/**
 * sudocache.js — process-local, short-lived sudo password cache.
 *
 * The sudo password is typed by the user in a local terminal and delivered to
 * this process over a private Unix socket (src/sudo.js). It is then kept only
 * in RAM, for at most REMOTE_SSH_SUDO_CACHE_MS milliseconds from the moment it
 * was entered. It is never written to a file, never logged, never serialized
 * into a tool result, and never placed in process argv; every cached copy is
 * overwritten with zeros when it is replaced, cleared, or expired.
 *
 * Entries are keyed by the SSH destination and port the password was entered
 * for, and each entry is bound to the resolved host/user/port from `ssh -G`.
 * A password is therefore never offered to a different resolved destination;
 * removing a target, or changing its ssh/port, drops its credential.
 *
 * Set REMOTE_SSH_SUDO_CACHE_MS=0 to disable caching (a terminal is then opened
 * for every sudo call that does not have a remote sudo ticket).
 */

const DEFAULT_TTL_MS = 20 * 60 * 1000
/** Bound the number of destinations holding a secret at once. */
const MAX_ENTRIES = 32

/** key -> { password: Buffer, expiresAt: number, timer?: NodeJS.Timeout, id: number, identity?: string } */
const entries = new Map()
/** Monotonic entry identity so a failure only drops the entry it used. */
let nextEntryId = 1

/**
 * Credential generations, used to stop a prompt that is still open from
 * re-caching a password after an explicit clear (target removed, ssh/port
 * changed, disconnect) or after a shutdown/test reset. Lazy expiry and
 * eviction are not explicit clears and must not advance a generation.
 */
const generations = new Map()
let resetEpoch = 0

/** Overwrite a secret in place. Best effort: copies held elsewhere are out of reach. */
function wipe(buffer) {
  buffer?.fill(0)
}

/** setTimeout's largest supported delay; longer TTLs fall back to lazy expiry. */
const MAX_TIMER_MS = 2_147_483_647

/** Remove an entry without advancing its generation (expiry/eviction). */
function dropEntry(key) {
  const entry = entries.get(key)
  if (entry === undefined) return
  entries.delete(key)
  clearTimeout(entry.timer)
  wipe(entry.password)
}

/**
 * Cache lifetime in milliseconds. Default 20 minutes; 0 disables the cache.
 * @returns {number}
 */
export function sudoCacheTtlMs() {
  const raw = process.env.REMOTE_SSH_SUDO_CACHE_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('REMOTE_SSH_SUDO_CACHE_MS must be a non-negative integer number of milliseconds')
  }
  return value
}

/**
 * Credential identity of a target: the SSH destination string and port. Two
 * targets that name the same destination share one cached credential, which
 * is correct because they resolve to the same remote account.
 * @param {{ ssh: string, port?: number }} target
 */
export function sudoCacheKey(target) {
  return `${target.ssh}\u0000${target.port ?? ''}`
}

/**
 * Opaque token identifying the current generation of a destination's
 * credential. A prompt captures this before it starts and passes it to
 * setCachedSudoPassword; an explicit clear invalidates the token.
 * @param {string} key
 * @returns {string}
 */
export function sudoCacheGeneration(key) {
  if (!generations.has(key)) generations.set(key, 0)
  return `${resetEpoch}:${generations.get(key)}`
}

/**
 * @param {string} key
 * @param {number} [now]
 * @returns {Buffer|undefined} a private copy the caller MUST wipe with
 *   `password.fill(0)` once it has been used
 */
export function getCachedSudoPassword(key, now = Date.now()) {
  return getCachedSudoPasswordEntry(key, { now })?.password
}

/**
 * Like getCachedSudoPassword, but also returns the entry token so a failed
 * authentication can drop exactly the entry it used (never a newer one that a
 * concurrent prompt just stored). Reuse requires the recorded identity to
 * equal the supplied one; in particular, an entry recorded with a resolved
 * identity is not reused when identity resolution now fails (both undefined
 * is allowed for environments without `ssh -G`).
 * @param {string} key
 * @param {{ now?: number, identity?: string }} [options]
 * @returns {{ password: Buffer, token: number } | undefined}
 */
export function getCachedSudoPasswordEntry(key, { now = Date.now(), identity } = {}) {
  const entry = entries.get(key)
  if (entry === undefined) return undefined
  if (entry.expiresAt <= now || entry.identity !== identity) {
    dropEntry(key)
    return undefined
  }
  return { password: Buffer.from(entry.password), token: entry.id }
}

/**
 * Store a password for `key`. A non-positive TTL is a no-op (cache disabled).
 * The cache keeps its own copy; the caller keeps ownership of `password`.
 * @param {string} key
 * @param {Buffer} password
 * @param {number} [ttlMs]
 * @param {number} [now]
 * @param {string} [expectedGeneration] token from sudoCacheGeneration; when
 *   supplied, the password is stored only if no explicit clear happened since
 * @param {string} [identity] resolved SSH host/user/port the password was
 *   entered for; entries with a different identity are never reused
 * @returns {boolean} whether the password was stored
 */
export function setCachedSudoPassword(key, password, ttlMs = sudoCacheTtlMs(), now = Date.now(), expectedGeneration, identity) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return false
  if (expectedGeneration !== undefined && expectedGeneration !== sudoCacheGeneration(key)) return false
  dropEntry(key)
  if (entries.size >= MAX_ENTRIES) {
    // Evict the entry closest to expiry; it is the least likely to be useful.
    let oldestKey
    let oldestAt = Infinity
    for (const [candidate, entry] of entries) {
      if (entry.expiresAt < oldestAt) {
        oldestAt = entry.expiresAt
        oldestKey = candidate
      }
    }
    dropEntry(oldestKey)
  }
  const expiresAt = now + ttlMs
  const entry = { password: Buffer.from(password), expiresAt, id: nextEntryId++, identity }
  if (ttlMs <= MAX_TIMER_MS) {
    // Wipe at the deadline even if no sudo call ever looks at the entry again.
    // The timer must not keep the process alive; a later access still checks
    // the deadline independently (lazy expiry remains the source of truth).
    entry.timer = setTimeout(() => {
      const current = entries.get(key)
      if (current?.expiresAt === expiresAt) dropEntry(key)
    }, ttlMs)
    entry.timer.unref()
  }
  entries.set(key, entry)
  return true
}

/** Drop one destination's credential and invalidate an open prompt's token. */
export function clearCachedSudoPassword(key) {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  dropEntry(key)
}

/**
 * Drop a credential without invalidating an open prompt (an authentication
 * failure: a fresh prompt may still be delivering a replacement password).
 * When `token` is supplied, drop only that exact entry.
 */
export function dropCachedSudoPassword(key, token) {
  const entry = entries.get(key)
  if (entry === undefined) return
  if (token !== undefined && entry.id !== token) return
  dropEntry(key)
}

/** Drop every credential; used on shutdown and by tests. */
export function clearAllSudoPasswords() {
  resetEpoch += 1
  for (const key of entries.keys()) dropEntry(key)
  // Old generation tokens carry the old epoch; clearing the map is safe and
  // keeps it from growing across many short-lived destinations.
  generations.clear()
}

/** Number of destinations currently holding a credential (tests/diagnostics). */
export function sudoCacheSize() {
  return entries.size
}
