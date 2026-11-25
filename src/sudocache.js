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
 * Entries are kept in one slot per SSH destination+port and resolved
 * host/user/port from `ssh -G`. A password is therefore never offered to a
 * different resolved destination, and concurrent prompts for different
 * identities cannot overwrite or drop each other's credential. Removing a
 * target, or changing its ssh/port, drops every slot of that destination;
 * a changed identity simply stops matching its old slot, which expires on its
 * own TTL.
 *
 * Set REMOTE_SSH_SUDO_CACHE_MS=0 to disable caching (a terminal is then opened
 * for every sudo call that does not have a remote sudo ticket).
 */

const DEFAULT_TTL_MS = 20 * 60 * 1000
/** Bound the number of destination/identity slots holding a secret at once. */
const MAX_ENTRIES = 32

/**
 * slot -> { password, expiresAt, timer?, id, destination, identity? }
 * A slot is (destination key, resolved identity); see credentialSlot().
 */
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
 * Destination key of a target: the SSH destination string and port. It scopes
 * management clears; credentials themselves live in one slot per destination
 * and resolved identity.
 * @param {{ ssh: string, port?: number }} target
 */
export function sudoCacheKey(target) {
  return `${target.ssh}\u0000${target.port ?? ''}`
}

/**
 * Unambiguous internal slot for one destination and one resolved identity.
 * JSON encoding avoids collisions between destinations/identities that contain
 * the separator characters themselves.
 */
function credentialSlot(key, identity) {
  return JSON.stringify([key, identity ?? null])
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
 * concurrent prompt just stored). The lookup is identity-scoped: a credential
 * entered for a resolved host/user/port is never returned when the caller has
 * a different identity, or none (for example when `ssh -G` failed now).
 * @param {string} key
 * @param {{ now?: number, identity?: string }} [options]
 * @returns {{ password: Buffer, token: number } | undefined}
 */
export function getCachedSudoPasswordEntry(key, { now = Date.now(), identity } = {}) {
  const slot = credentialSlot(key, identity)
  const entry = entries.get(slot)
  if (entry === undefined) return undefined
  if (entry.expiresAt <= now) {
    dropEntry(slot)
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
 *   entered for; this is part of the storage slot
 * @returns {boolean} whether the password was stored
 */
export function setCachedSudoPassword(key, password, ttlMs = sudoCacheTtlMs(), now = Date.now(), expectedGeneration, identity) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return false
  if (expectedGeneration !== undefined && expectedGeneration !== sudoCacheGeneration(key)) return false
  const slot = credentialSlot(key, identity)
  dropEntry(slot)
  if (entries.size >= MAX_ENTRIES) {
    // Evict the entry closest to expiry; it is the least likely to be useful.
    let oldestSlot
    let oldestAt = Infinity
    for (const [candidate, entry] of entries) {
      if (entry.expiresAt < oldestAt) {
        oldestAt = entry.expiresAt
        oldestSlot = candidate
      }
    }
    dropEntry(oldestSlot)
  }
  const expiresAt = now + ttlMs
  const entry = { password: Buffer.from(password), expiresAt, id: nextEntryId++, destination: key, identity }
  if (ttlMs <= MAX_TIMER_MS) {
    // Wipe at the deadline even if no sudo call ever looks at the entry again.
    // The timer must not keep the process alive; a later access still checks
    // the deadline independently (lazy expiry remains the source of truth).
    entry.timer = setTimeout(() => {
      const current = entries.get(slot)
      if (current?.expiresAt === expiresAt) dropEntry(slot)
    }, ttlMs)
    entry.timer.unref()
  }
  entries.set(slot, entry)
  return true
}

/** Drop every credential slot of a destination and invalidate open prompts. */
export function clearCachedSudoPassword(key) {
  generations.set(key, (generations.get(key) ?? 0) + 1)
  for (const [slot, entry] of entries) {
    if (entry.destination === key) dropEntry(slot)
  }
}

/**
 * Drop a credential without invalidating an open prompt (an authentication
 * failure: a fresh prompt may still be delivering a replacement password).
 * When `token` is supplied, drop only that exact entry.
 */
export function dropCachedSudoPassword(key, token) {
  for (const [slot, entry] of entries) {
    if (entry.destination !== key) continue
    if (token !== undefined && entry.id !== token) continue
    dropEntry(slot)
  }
}

/** Drop every credential; used on shutdown and by tests. */
export function clearAllSudoPasswords() {
  resetEpoch += 1
  for (const slot of entries.keys()) dropEntry(slot)
  // Old generation tokens carry the old epoch; clearing the map is safe and
  // keeps it from growing across many short-lived destinations.
  generations.clear()
}

/** Number of cached credentials, one per destination and resolved identity. */
export function sudoCacheSize() {
  return entries.size
}
