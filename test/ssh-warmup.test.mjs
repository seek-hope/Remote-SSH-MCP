import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureControlMaster } from '../src/ssh.js'

/**
 * Shared warm-up semantics: one in-flight warm-up per destination, and a
 * caller's abort must NOT kill the shared warm-up out from under the other
 * callers waiting on it.
 *
 * Fake ssh: `-O check` reports no master; headless probes wait for an
 * explicit release file so cancellation is tested without timing races.
 */
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\\n')
if (argv.includes('-G')) { console.log('controlpath ' + process.env.REMOTE_SSH_CONTROL_DIR + '/fake'); process.exit(0) }
if (argv.includes('-O')) {
  process.exit(255) // no master yet
}
setInterval(() => {
  if (fs.existsSync(process.env.FAKE_SSH_LOG + '.release')) process.exit(0)
}, 10)
`

async function withFakeSsh(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-warmup-'))
  const bin = join(dir, 'ssh')
  const log = join(dir, 'argv.log')
  process.env.REMOTE_SSH_CONTROL_DIR = join(dir, 'control')
  await writeFile(bin, FAKE_SSH)
  await chmod(bin, 0o755)
  process.env.FAKE_SSH_LOG = log
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${process.env.PATH}`
  try {
    return await fn(log)
  } finally {
    delete process.env.FAKE_SSH_LOG
    delete process.env.REMOTE_SSH_CONTROL_DIR
    process.env.PATH = prevPath
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitForCalls(log, predicate) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const text = await readFile(log, 'utf8').catch(() => '')
    const calls = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (predicate(calls)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('fake ssh did not reach the expected call')
}

for (const interactive of [false, true]) test(`caller cancellation preserves shared warm-up (interactive=${interactive})`, async () => {
  await withFakeSsh(async (log) => {
    const target = { name: 'warm-shared', ssh: `warm-shared-${interactive}`, root: '/srv', controlPersist: 60 }
    const ctrlA = new AbortController()
    const a = ensureControlMaster(target, { interactive, signal: ctrlA.signal })
    let b
    let ra
    try {
      await waitForCalls(log, calls => calls.some(argv => !argv.includes('-O') && !argv.includes('-G')))
      ctrlA.abort()
      ra = await a
      // The later caller arrives AFTER the first caller has detached.
      b = ensureControlMaster(target, { interactive })
      await waitForCalls(log, calls => calls.filter(argv => argv.includes('-O')).length === 3)
    } finally {
      await writeFile(`${log}.release`, '')
      await Promise.all([a, b])
    }
    const rb = await b
    assert.equal(ra.ok, false)
    assert.equal(ra.mode, 'aborted', 'caller A detaches as aborted')
    assert.equal(rb.ok, true, `caller B must still get the warm-up result (got ${JSON.stringify(rb)})`)
    assert.equal(rb.mode, 'started')

    const calls = JSON.parse(`[${(await readFile(log, 'utf8')).trim().split('\n').join(',')}]`)
    const probes = calls.filter((argv) => !argv.includes('-O') && !argv.includes('-G'))
    assert.equal(probes.length, 1, 'exactly ONE shared headless warm-up ran')
  })
})
