import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSudoPromptScript, runSudoCommand } from '../src/sudo.js'
import { makeSudoTool } from '../src/tools/sudo.js'
import {
  clearAllSudoPasswords,
  getCachedSudoPasswordEntry,
  setCachedSudoPassword,
  sudoCacheKey,
  sudoCacheSize,
} from '../src/sudocache.js'
import { resolveSshIdentity } from '../src/ssh.js'
import { manageTargets } from '../src/manage.js'
import { saveTargetStore } from '../src/store.js'
import { installLocalSsh, installFakeSsh, installFakeSudo, installFakeTerminal } from './helpers.mjs'

const target = { ssh: 'h', name: 'h', port: undefined, controlPersist: 0 }
const key = sudoCacheKey(target)
const linux = { skip: process.platform !== 'linux' }

test.beforeEach(() => {
  clearAllSudoPasswords()
  delete process.env.REMOTE_SSH_SUDO_CACHE_MS
})

/**
 * The fake ssh executes the real remote wrapper locally; the fake sudo
 * emulates the ticket/password modes. The terminal fake delivers the password
 * without a desktop session.
 */
async function harness(options = {}) {
  const ssh = await installLocalSsh()
  const sudo = await installFakeSudo({ dir: ssh.dir, ...options })
  const term = await installFakeTerminal({ password: options.terminalPassword ?? options.password ?? 'fakepw', delayMs: options.terminalDelayMs ?? 0 })
  return {
    ssh,
    sudo,
    term,
    async cleanup() {
      await term.cleanup()
      await sudo.cleanup()
      await ssh.cleanup()
    },
  }
}

const run = (extra = {}) => runSudoCommand(target, { command: 'id -u', workdir: '/', timeoutMs: 10_000, ...extra })

test('the terminal prompt reads the password silently and delivers it over the private socket', () => {
  const script = buildSudoPromptScript({
    socket: '/tmp/sudo/askpass.sock',
    prompt: 'sudo password for h [h]: ',
    promptTimeoutSeconds: 150,
    nodePath: '/usr/bin/node',
  })
  // Read without echo, into a shell variable; never written to a file.
  assert.match(script, /read -r -s -t 150 pw/)
  assert.match(script, /set \+x \+v/)
  assert.match(script, /unset HISTFILE/)
  // The value is piped to the local node client (a builtin printf, never argv).
  assert.match(script, /printf 'OK\\n%s' "\$pw" \|/)
  assert.match(script, /askpass\.sock/)
  // The prompt path does not run the remote command or create result files.
  assert.doesNotMatch(script, /\bssh\b/)
  assert.doesNotMatch(script, /stdout|stderr|ssh\.pid/)
})

test('a valid remote ticket runs the command once without a password or terminal', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: 'printf root; exit 7' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.code, 7)
    assert.equal(result.stdout, 'root')
    assert.equal((await h.term.readLog()).length, 0, 'no terminal for a passwordless sudo')
    const sudoLog = await h.sudo.readLog()
    assert.equal(sudoLog.length, 3, 'probe, command-mode ticket check, and one command invocation')
    assert.equal(sudoLog.filter(line => line.includes(' -- ')).length, 1, 'the command runs exactly once')
    assert.doesNotMatch(JSON.stringify(sudoLog), /fakepw/)
    assert.doesNotMatch(JSON.stringify(await h.ssh.readLog()), /fakepw/, 'the password never enters ssh argv')
  } finally {
    await h.cleanup()
  }
})

test('a password entered once is reused from memory without another prompt', async () => {
  const h = await harness({ password: 'fakepw' })
  try {
    const first = await run({ command: 'printf root' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.stdout, 'root')
    assert.equal((await h.term.readLog()).length, 1)
    const cached = getCachedSudoPasswordEntry(key, { identity: await resolveSshIdentity(target) })
    assert.equal(cached?.password.toString(), 'fakepw')
    cached?.password.fill(0)

    const second = await run({ command: 'printf root' })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal((await h.term.readLog()).length, 1, 'the cached password avoided a second terminal')
    assert.equal((await h.sudo.readLog()).filter(line => line.startsWith('-S ')).length, 2, 'both calls validated a password')
    assert.equal((await h.sudo.readLog()).filter(line => line.includes(' -- ')).length, 2)
    assert.doesNotMatch(JSON.stringify(await h.ssh.readLog()), /fakepw/)
  } finally {
    await h.cleanup()
  }
})

test('a rejected password is reported, not cached, and no command runs', async () => {
  const h = await harness({ password: 'right', terminalPassword: 'wrong' })
  try {
    const result = await run()
    assert.equal(result.ok, false)
    assert.match(result.error, /sudo authentication failed/)
    assert.match(result.error, /incorrect password/)
    assert.doesNotMatch(result.error, /wrong/)
    assert.equal(sudoCacheSize(), 0, 'a rejected password must not be cached')
    assert.equal((await h.sudo.readLog()).filter(line => line.includes(' -- ')).length, 0, 'the command never ran')
    assert.equal((await h.term.readLog()).length, 1)

    const again = await run()
    assert.equal(again.ok, false)
    assert.equal((await h.term.readLog()).length, 2, 'the rejected password was not reused')
  } finally {
    await h.cleanup()
  }
})

test('a stale cached password is dropped and the next call asks again', async () => {
  const h = await harness({ password: 'fakepw' })
  const identity = await resolveSshIdentity(target)
  setCachedSudoPassword(key, Buffer.from('stale'), undefined, Date.now(), undefined, identity)
  try {
    const first = await run()
    assert.equal(first.ok, false)
    assert.match(first.error, /sudo authentication failed/)
    assert.equal(sudoCacheSize(), 0, 'the rejected credential is dropped')
    assert.equal((await h.term.readLog()).length, 0, 'a stale credential is not retried in the same call')
    assert.equal((await h.sudo.readLog()).filter(line => line.includes(' -- ')).length, 0, 'the command never ran')

    const second = await run()
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.equal((await h.term.readLog()).length, 1, 'the next call asks for the replacement password')
    const cached = getCachedSudoPasswordEntry(key, { identity: await resolveSshIdentity(target) })
    assert.equal(cached?.password.toString(), 'fakepw')
    cached?.password.fill(0)
  } finally {
    await h.cleanup()
  }
})

test('concurrent sudo calls on one destination share a single terminal prompt', async () => {
  const h = await harness({ password: 'fakepw' })
  try {
    const [a, b] = await Promise.all([run(), run()])
    assert.equal(a.ok, true, JSON.stringify(a))
    assert.equal(b.ok, true, JSON.stringify(b))
    assert.equal((await h.term.readLog()).length, 1, 'one prompt serves both calls')
  } finally {
    await h.cleanup()
  }
})

test('a missing terminal surfaces an error instead of blocking', async () => {
  const h = await harness({ password: 'fakepw' })
  const previous = process.env.REMOTE_SSH_TERMINAL
  process.env.REMOTE_SSH_TERMINAL = 'remote-ssh-no-such-terminal-xyz'
  try {
    const result = await run({ timeoutMs: 5000 })
    assert.equal(result.ok, false)
    assert.match(result.error, /cannot open a terminal for the sudo password/)
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SSH_TERMINAL
    else process.env.REMOTE_SSH_TERMINAL = previous
    await h.cleanup()
  }
})

test('a terminal that never delivers a password is bounded by the prompt budget', async () => {
  const h = await harness({ password: 'fakepw' })
  const previous = process.env.REMOTE_SSH_TERMINAL
  process.env.REMOTE_SSH_TERMINAL = 'true' // exits without sending a password
  try {
    const started = Date.now()
    const result = await run({ timeoutMs: 600 })
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.match(result.error, /no sudo password was entered/)
    assert.ok(elapsed < 3000, `the call returned after ${elapsed}ms`)
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SSH_TERMINAL
    else process.env.REMOTE_SSH_TERMINAL = previous
    await h.cleanup()
  }
})

test('REMOTE_SSH_SUDO_CACHE_MS=0 prompts for every call and stores nothing', async () => {
  process.env.REMOTE_SSH_SUDO_CACHE_MS = '0'
  const h = await harness({ password: 'fakepw' })
  try {
    assert.equal((await run()).ok, true)
    assert.equal((await run()).ok, true)
    assert.equal((await h.term.readLog()).length, 2)
    assert.equal(sudoCacheSize(), 0)
  } finally {
    delete process.env.REMOTE_SSH_SUDO_CACHE_MS
    await h.cleanup()
  }
})

test('the command runs inside the sudo working directory', async () => {
  const h = await harness({ ticket: true })
  const dir = await mkdtemp(join(tmpdir(), 'remote-sudo-cwd-'))
  try {
    const result = await run({ command: 'pwd', workdir: dir })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.stdout.trim(), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await h.cleanup()
  }
})

test('a missing working directory is reported as such, not as an authentication failure', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ workdir: '/definitely/not/a/real/directory-xyz' })
    assert.equal(result.ok, false)
    assert.match(result.error, /cannot change to remote working directory/)
    assert.equal((await h.term.readLog()).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('a sudoers that does not keep a ticket is reported instead of leaking the password', async () => {
  const h = await harness({ password: 'fakepw', noTicket: true })
  try {
    const result = await run()
    assert.equal(result.ok, false)
    assert.match(result.error, /timestamp_timeout/)
    assert.equal((await h.sudo.readLog()).filter(line => line.includes(' -- ')).length, 0, 'the command never ran')
  } finally {
    await h.cleanup()
  }
})

test('a sudo policy refusal never opens a password terminal', async () => {
  const h = await harness({ policy: true })
  try {
    const result = await run()
    assert.equal(result.ok, false)
    assert.match(result.error, /sudo is not permitted/)
    assert.equal((await h.term.readLog()).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('the command cannot read a password sudo did not consume', linux, async () => {
  // NOPASSWD simulation: the password is sent (the probe failed) but sudo
  // does not read it. The wrapper must drain it before user code starts.
  const h = await harness({ password: 'fakepw', skipRead: true })
  try {
    const result = await run({ command: 'readlink /proc/$$/fd/0; cat /proc/$PPID/fd/0 2>/dev/null; echo "rc=$?"' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.stdout, /^\/dev\/null\n/, 'the command own stdin is /dev/null')
    assert.match(result.stdout, /rc=0/, 'the ancestor stdin must be readable, otherwise this test proves nothing')
    assert.doesNotMatch(result.stdout, /fakepw/, 'the password must not be readable by the command')
  } finally {
    await h.cleanup()
  }
})

test('a command syntax error is a command failure, not an authentication failure', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: 'if true' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.code, 2)
    assert.match(result.stderr, /syntax error/)
    assert.equal((await h.term.readLog()).length, 0)
  } finally {
    await h.cleanup()
  }
})

test('a command that kills itself is reported once, never re-run', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: 'kill -9 $$' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.code, 137)
    assert.equal((await h.term.readLog()).length, 0)
    assert.equal((await h.sudo.readLog()).filter(line => line.includes(' -- ')).length, 1)
  } finally {
    await h.cleanup()
  }
})

test('the command exit code is preserved, including 255', async () => {
  const h = await harness({ ticket: true })
  try {
    assert.equal((await run({ command: 'exit 255' })).code, 255)
    assert.equal((await run({ command: 'exit 42' })).code, 42)
  } finally {
    await h.cleanup()
  }
})

test('large stdout is tail-truncated with the documented flag', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: "head -c 600000 /dev/zero | tr '\\0' a" })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.stdoutTruncated, true)
    assert.ok(result.stdout.length <= 512 * 1024)
  } finally {
    await h.cleanup()
  }
})

test('removing, changing the destination of, or disconnecting a target drops its credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-sudo-manage-'))
  const storeFile = join(dir, 'targets.json')
  const ssh = await installLocalSsh()
  try {
    await saveTargetStore(storeFile, [{ name: 'h', ssh: 'h', root: '/', controlPersist: 0 }])
    setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
    await manageTargets({ action: 'remove', target: 'h' }, storeFile)
    assert.equal(sudoCacheSize(), 0, 'remove clears the destination credential')

    await saveTargetStore(storeFile, [{ name: 'h', ssh: 'h', root: '/', controlPersist: 0 }])
    setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
    await manageTargets({ action: 'update', target: 'h', root: '/tmp' }, storeFile)
    assert.equal(sudoCacheSize(), 1, 'an unrelated update keeps the credential')

    await manageTargets({ action: 'update', target: 'h', ssh: 'h2' }, storeFile)
    assert.equal(sudoCacheSize(), 0, 'changing ssh clears the old destination credential')

    setCachedSudoPassword(sudoCacheKey({ ssh: 'h2' }), Buffer.from('x'))
    await manageTargets({ action: 'disconnect', target: 'h' }, storeFile)
    assert.equal(sudoCacheSize(), 0, 'disconnect clears the credential even with ControlPersist disabled')
  } finally {
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a command that floods stderr and exits or kills itself is still reported as run', async () => {
  const h = await harness({ ticket: true })
  try {
    const exited = await run({ command: "head -c 200000 /dev/zero | tr '\\0' a >&2; exit 3" })
    assert.equal(exited.ok, true, JSON.stringify(exited))
    assert.equal(exited.code, 3)
    assert.equal(exited.stderrTruncated, true)
    const killed = await run({ command: "head -c 200000 /dev/zero | tr '\\0' a >&2; kill -9 $$" })
    assert.equal(killed.ok, true, JSON.stringify(killed))
    assert.equal(killed.code, 137)
  } finally {
    await h.cleanup()
  }
})

test('a command timeout is reported as a timeout', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: 'sleep 2', timeoutMs: 400 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
  } finally {
    await h.cleanup()
  }
})

test('disconnect clears the credential even when closing the master fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-sudo-disconnect-'))
  const storeFile = join(dir, 'targets.json')
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_FAIL_MATCH = '-O'
  process.env.FAKE_SSH_FAIL_EXIT = '1'
  process.env.FAKE_SSH_FAIL_STDERR = 'Control socket connect: Permission denied\n'
  try {
    await saveTargetStore(storeFile, [{ name: 'h', ssh: 'h', root: '/', controlPersist: 43200 }])
    setCachedSudoPassword(sudoCacheKey({ ssh: 'h' }), Buffer.from('x'))
    await assert.rejects(
      manageTargets({ action: 'disconnect', target: 'h' }, storeFile),
      /Permission denied|Failed to disconnect/,
    )
    assert.equal(sudoCacheSize(), 0, 'an explicit disconnect drops the credential even on an error path')
  } finally {
    delete process.env.FAKE_SSH_FAIL_MATCH
    delete process.env.FAKE_SSH_FAIL_EXIT
    delete process.env.FAKE_SSH_FAIL_STDERR
    await fake.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a drain that cannot run refuses to execute the command', linux, async () => {
  const ssh = await installLocalSsh()
  const sudo = await installFakeSudo({ dir: ssh.dir, password: 'fakepw', skipRead: true })
  const term = await installFakeTerminal({ password: 'fakepw' })
  const shimDir = await mkdtemp(join(tmpdir(), 'shim-bash-'))
  await writeFile(join(shimDir, 'bash'), '#!/bin/sh\nexit 126\n', { mode: 0o755 })
  const previousPath = process.env.PATH
  const previousTerm = process.env.REMOTE_SSH_TERMINAL
  process.env.PATH = `${shimDir}:${previousPath}`
  // The prompt launcher must keep working while the remote wrapper's bash is
  // the failing shim.
  process.env.REMOTE_SSH_TERMINAL = `/bin/bash ${join(term.dir, 'terminal.sh')}`
  try {
    const result = await run({ command: 'id' })
    assert.equal(result.ok, false)
    assert.match(result.error, /could not be drained safely/)
    assert.equal((await sudo.readLog()).filter(line => line.includes(' -- ')).length, 0, 'the command never ran')
  } finally {
    process.env.PATH = previousPath
    if (previousTerm === undefined) delete process.env.REMOTE_SSH_TERMINAL
    else process.env.REMOTE_SSH_TERMINAL = previousTerm
    await rm(shimDir, { recursive: true, force: true })
    await term.cleanup()
    await sudo.cleanup()
    await ssh.cleanup()
  }
})

test('a changed resolved SSH identity drops the cached credential', async () => {
  const h = await harness({ password: 'fakepw' })
  const previous = process.env.FAKE_SSH_IDENTITY_HOST
  process.env.FAKE_SSH_IDENTITY_HOST = 'host-a'
  try {
    assert.equal((await run()).ok, true)
    assert.equal(sudoCacheSize(), 1)
    assert.equal((await h.term.readLog()).length, 1)
    process.env.FAKE_SSH_IDENTITY_HOST = 'host-b'
    assert.equal((await run()).ok, true)
    assert.equal((await h.term.readLog()).length, 2, 'a changed HostName forces a new prompt')
  } finally {
    if (previous === undefined) delete process.env.FAKE_SSH_IDENTITY_HOST
    else process.env.FAKE_SSH_IDENTITY_HOST = previous
    await h.cleanup()
  }
})

test('a command-mode ticket re-check failure never runs the command', async () => {
  const h = await harness({ ticket: true, failAfterProbe: true })
  try {
    const result = await run()
    assert.equal(result.ok, false)
    assert.match(result.error, /timestamp_timeout/)
    assert.equal((await h.sudo.readLog()).filter(line => line.includes(' -- ')).length, 0, 'the command never ran')
  } finally {
    await h.cleanup()
  }
})

test('a command that prints its own cmdline is not misreported as a cd failure', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: "tr '\\0' '\\n' < /proc/$$/cmdline >&2; echo COMMAND_RAN" })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.stdout, /COMMAND_RAN/)
  } finally {
    await h.cleanup()
  }
})

test('a short-budget waiter does not abort a shared prompt for a longer caller', async () => {
  const h = await harness({ password: 'fakepw', terminalDelayMs: 2500 })
  try {
    const [short, long] = await Promise.all([
      run({ timeoutMs: 1200 }),
      run({ timeoutMs: 10_000 }),
    ])
    assert.equal(short.ok, false)
    assert.match(short.error, /no sudo password/)
    assert.equal(long.ok, true, JSON.stringify(long))
    assert.equal((await h.term.readLog()).length, 1, 'one shared prompt served both callers')
  } finally {
    await h.cleanup()
  }
})

test('a timed-out sudo command keeps output truncation flags', async () => {
  const h = await harness({ ticket: true })
  try {
    const result = await run({ command: "head -c 600000 /dev/zero | tr '\\0' a; sleep 2", timeoutMs: 500 })
    assert.equal(result.timedOut, true)
    assert.equal(result.stdoutTruncated, true)
    assert.ok(result.stdout.length <= 512 * 1024)
  } finally {
    await h.cleanup()
  }
})

test('the sudo tool rejects undecodable commands before prompting', async () => {
  const tool = makeSudoTool({ ssh: 'h', name: 'h', root: '/', controlPersist: 0 })
  const signal = new AbortController().signal
  await assert.rejects(tool.execute({ command: 'echo \ud800' }, { signal }), /surrogate|UTF-8/)
  await assert.rejects(tool.execute({ command: 'id', workdir: 'bad\ud800' }, { signal }), /surrogate|UTF-8/)
})
