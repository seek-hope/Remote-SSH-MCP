import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureControlMaster } from '../src/ssh.js'

/**
 * Regression: ensureControlMaster must pass the target's ssh DESTINATION
 * string into sshExec, never the whole target object. Passing the object made
 * spawn stringify it to "[object Object]" and OpenSSH fail with
 * "hostname contains invalid characters" whenever no ControlMaster existed —
 * i.e. exactly the first tool call after the harness restarted.
 */
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\\n')
if (argv.includes('-G')) { console.log('controlpath ' + process.env.REMOTE_SSH_CONTROL_DIR + '/fake'); process.exit(0) }
if (argv.includes('-O')) {
  fs.writeSync(2, 'Control socket connect(...): No such file or directory')
  process.exit(255) // no master yet -> exercise the headless start path
}
process.exit(0)
`

test('ensureControlMaster starts the master with the destination string, not the target object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-autoconnect-dest-'))
  const bin = join(dir, 'ssh')
  const log = join(dir, 'argv.log')
  process.env.REMOTE_SSH_CONTROL_DIR = join(dir, 'control')
  await writeFile(bin, FAKE_SSH)
  await chmod(bin, 0o755)
  process.env.FAKE_SSH_LOG = log
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${process.env.PATH}`
  try {
    const result = await ensureControlMaster(
      { name: 'fake', ssh: 'fake-host', root: '/srv', controlPersist: 60 },
      { interactive: false },
    )
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'started')

    const calls = JSON.parse(`[${(await readFile(log, 'utf8')).trim().split('\n').join(',')}]`)
    const probe = calls.find((argv) => !argv.includes('-O') && !argv.includes('-G'))
    assert.ok(probe, 'expected the headless sshExec probe')
    const dash = probe.indexOf('--')
    assert.ok(dash !== -1, 'expected "--" in the probe argv')
    assert.equal(probe[dash + 1], 'fake-host')
    assert.match(probe[dash + 2], /^sh -c /)
    assert.ok(probe[dash + 2].includes(Buffer.from('true').toString('base64')))
  } finally {
    delete process.env.FAKE_SSH_LOG
    delete process.env.REMOTE_SSH_CONTROL_DIR
    process.env.PATH = prevPath
    await rm(dir, { recursive: true, force: true })
  }
})
