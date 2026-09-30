/**
 * store.js — atomic JSON target persistence.
 *
 * Callers read the current file for every operation; mutation ordering and
 * cross-process exclusion live in lock.js and are re-exported here so callers
 * keep a single import site.
 */

import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseTargets } from './target.js'

export { withStoreLock, _lockTestHooks } from './lock.js'

/**
 * Persist the target list atomically (tmp + rename).
 * @param {string} file
 * @param {import('./target.js').RemoteTarget[]} targets
 */
export async function saveTargetStore(file, targets) {
  await mkdir(dirname(file), { recursive: true })
  // Unique per call (pid alone would collide across concurrent writers in one
  // process); removed on failure so a crash never leaves a stale tmp behind.
  const tmp = join(dirname(file), `.remote-ssh-targets.${process.pid}.${randomUUID()}.tmp`)
  // JSON.stringify omits optional fields whose value is undefined.
  const body = targets.map((t) => ({ ...t, name: t.name, ssh: t.ssh, root: t.root }))
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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
    json = JSON.parse(raw)
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
