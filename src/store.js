/**
 * store.js — atomic JSON target persistence.
 *
 * Callers read the current file for every operation; mutation ordering and
 * cross-process exclusion live in lock.js and are re-exported here so callers
 * keep a single import site.
 */

import { readFile, writeFile, rename, rm, mkdir, readdir, stat, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseTargets } from './target.js'

export { withStoreLock, _lockTestHooks } from './lock.js'

const TMP_PREFIX = '.remote-ssh-targets.'
const TMP_SUFFIX = '.tmp'
/** A tmp file this old can only be a leftover from a killed writer. */
const STALE_TMP_MS = 5 * 60 * 1000

/**
 * Remove tmp files left by a hard crash between write and rename. Saves are
 * atomic, but a SIGKILL/power loss skips the error cleanup; without a sweep
 * those files accumulate forever. Best effort: never fails a save.
 */
async function sweepStaleTmp(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  await Promise.all(names
    .filter((name) => name.startsWith(TMP_PREFIX) && name.endsWith(TMP_SUFFIX))
    .map(async (name) => {
      const full = join(dir, name)
      try {
        const { mtimeMs } = await stat(full)
        if (Math.abs(now - mtimeMs) > STALE_TMP_MS) await rm(full, { force: true })
      } catch { /* raced away or unreadable */ }
    }))
}

/**
 * Persist the target list atomically (tmp + rename).
 * @param {string} file
 * @param {import('./target.js').RemoteTarget[]} targets
 */
export async function saveTargetStore(file, targets) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  await sweepStaleTmp(dir)
  // Unique per call (pid alone would collide across concurrent writers in one
  // process); removed on failure so a crash never leaves a stale tmp behind.
  const tmp = join(dir, `${TMP_PREFIX}${process.pid}.${randomUUID()}${TMP_SUFFIX}`)
  // JSON.stringify omits optional fields whose value is undefined.
  const body = targets.map((t) => ({ ...t, name: t.name, ssh: t.ssh, root: t.root }))
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    // writeFile's mode is masked by the process umask; enforce the documented
    // 0600 before publishing the file.
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Strictly read the store for MUTATIONS and management lookups: a missing
 * file (ENOENT) means "no targets yet" and yields [], but every other
 * problem — malformed JSON, a non-array body, an invalid target row —
 * THROWS. A corrupt store must be diagnosed and preserved, never silently
 * read as [] (the next mutation would then persist that empty list over the
 * user's targets). Every caller uses this strict reader.
 * @param {string} file
 * @returns {Promise<import('./target.js').RemoteTarget[]>}
 */
export async function readTargetStoreStrict(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return [] // no store yet: no targets
    throw e
  }
  let json
  try {
    // Strip a UTF-8 BOM: editors add one, JSON.parse rejects it, and the store
    // is documented as hand-editable.
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    json = JSON.parse(body)
  } catch (e) {
    throw new Error(`target store ${file} is not valid JSON (${e.message}); refusing to modify it — fix or remove the file first`)
  }
  const list = json
  if (!Array.isArray(list)) {
    throw new Error(`target store ${file} must be a JSON array of targets; refusing to modify it`)
  }
  try {
    return parseTargets(list)
  } catch (e) {
    throw new Error(`target store ${file} holds an invalid target (${e.message}); refusing to modify it — fix or remove the file first`)
  }
}
