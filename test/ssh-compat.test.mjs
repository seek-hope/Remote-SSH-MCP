import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildConnectCommand, openConnectTerminal, sshExec, sshRun } from '../src/ssh.js'
import { installFakeSsh } from './helpers.mjs'

test('command and authentication sessions isolate interactive SSH settings but preserve the route and identity', async () => {
  const originalPath = process.env.PATH
  const fake = await installFakeSsh()
  const config = join(fake.dir, 'config')
  await writeFile(config, `Host *
  HostName server.example.invalid
  User configured-user
  IdentityFile /test/configured-key
  ProxyJump configured-jump
  RemoteCommand echo interactive-login
  RequestTTY force
  SessionType subsystem
  StdinNull yes
  ForkAfterAuthentication yes
  LocalForward 127.0.0.1:54321 127.0.0.1:22
  ExitOnForwardFailure yes
`)
  try {
    await sshExec({ target: 'alias', port: 2200, controlPersist: 0, command: 'true' })
    process.env.FAKE_SSH_MARK = '0'
    await sshRun({ target: 'alias', port: 2200, controlPersist: 0, command: 'true' })
    delete process.env.FAKE_SSH_MARK
    const terminal = spawnSync('sh', ['-c', buildConnectCommand({ ssh: 'alias', port: 2200 })], { encoding: 'utf8' })
    assert.equal(terminal.status, 0, terminal.stderr)
    const calls = await fake.readLog()
    assert.equal(calls.length, 3)
    for (const args of calls) {
      assert.ok(args.includes('RemoteCommand=none'), 'must not combine configured and MCP commands')
      assert.ok(args.includes('ClearAllForwardings=yes'), 'must not rebind configured forwarded ports')
      const native = spawnSync('ssh', ['-G', '-F', config, ...args], {
        encoding: 'utf8', env: { ...process.env, PATH: originalPath }, timeout: 5000,
      })
      assert.equal(native.status, 0, native.stderr)
      for (const line of ['hostname server.example.invalid', 'user configured-user', 'port 2200',
        'identityfile /test/configured-key', 'proxyjump configured-jump', 'requesttty false', 'clearallforwardings yes']) {
        // OpenSSH releases print RequestTTY=no as either "no" or "false".
        assert.ok(native.stdout.replace('requesttty no', 'requesttty false').includes(line), line)
      }
      assert.doesNotMatch(native.stdout, /^localforward /m)
      assert.doesNotMatch(native.stdout, /remotecommand echo interactive-login/)
      if (!args.includes('-f')) {
        for (const line of ['sessiontype default', 'stdinnull no', 'forkafterauthentication no']) assert.ok(native.stdout.includes(line), line)
      } else {
        assert.ok(native.stdout.includes('sessiontype none'))
        assert.ok(args.includes('BatchMode=no'))
        assert.ok(args.includes('StrictHostKeyChecking=ask'))
      }
    }
  } finally {
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('shared transport selects POSIX sh and preserves stdin, quotes and exit status', async () => {
  const fake = await installFakeSsh()
  await writeFile(join(fake.dir, 'ssh'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const command = process.argv.at(-1)
if (!command.startsWith('sh -c ') || /[\\n\\r!]/.test(command)) {
  console.error('Non-POSIX login shell: explicitly select sh before sending shell syntax')
  process.exit(2)
}
const result = spawnSync('sh', ['-c', command], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  const payload = "quote' $HOME `uname` 中文\nsecond line\n"
  try {
    const opts = { target: 'alias', controlPersist: 0, stdin: payload, command: '# Multiline script!\nbody=$(cat); printf "%s\\n" "$body"' }
    assert.equal((await sshExec(opts)).toString(), payload)
    const result = await sshRun({ ...opts, command: opts.command + '; printf error >&2; exit 7' })
    assert.equal(result.stdout, payload.trimEnd())
    assert.equal(result.stderr, 'error')
    assert.equal(result.code, 7)
    await writeFile(join(fake.dir, 'base64'), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
    await assert.rejects(sshExec(opts), /exit 127/)
  } finally {
    await fake.cleanup()
  }
})

test('a terminal that exits unsuccessfully is not reported as opened', async () => {
  const fake = await installFakeSsh()
  const before = { REMOTE_SSH_TERMINAL: process.env.REMOTE_SSH_TERMINAL, REMOTE_SSH_CONTROL_DIR: process.env.REMOTE_SSH_CONTROL_DIR }
  const launcher = join(fake.dir, 'terminal.cjs')
  await writeFile(launcher, 'process.exit(3)\n')
  process.env.REMOTE_SSH_TERMINAL = `"${process.execPath}" "${launcher}"`
  process.env.REMOTE_SSH_CONTROL_DIR = join(fake.dir, 'control')
  try {
    const result = await openConnectTerminal({ name: 'alias', ssh: 'alias' })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.error, /exit.*3/)
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fake.cleanup()
  }
})

test('Linux terminal detection tries the next launcher after an immediate failure', { skip: process.platform !== 'linux' }, async () => {
  const fake = await installFakeSsh()
  const before = { REMOTE_SSH_TERMINAL: process.env.REMOTE_SSH_TERMINAL, REMOTE_SSH_CONTROL_DIR: process.env.REMOTE_SSH_CONTROL_DIR }
  const marker = join(fake.dir, 'launched')
  await writeFile(join(fake.dir, 'gnome-terminal'), `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
  await writeFile(join(fake.dir, 'konsole'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')\n`, { mode: 0o755 })
  delete process.env.REMOTE_SSH_TERMINAL
  process.env.REMOTE_SSH_CONTROL_DIR = join(fake.dir, 'control')
  process.env.PATH = fake.dir
  try {
    const result = await openConnectTerminal({ name: 'alias', ssh: 'alias' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.terminal, 'konsole')
    assert.equal(await readFile(marker, 'utf8'), 'ok')
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fake.cleanup()
  }
})
