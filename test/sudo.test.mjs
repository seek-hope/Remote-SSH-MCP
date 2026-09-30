import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSudoTerminalScript, runSudoCommand } from '../src/sudo.js'
import { installFakeSsh, installFakeTerminal } from './helpers.mjs'

const target = { ssh: 'h', name: 'h', port: undefined, controlPersist: 0 }

test('the terminal script reads the password silently and never embeds a secret', () => {
  const script = buildSudoTerminalScript({
    sshLine: "'ssh' '-T' '--' 'h' 'sh -c ...'",
    out: '/tmp/sudo/stdout',
    err: '/tmp/sudo/stderr',
    exit: '/tmp/sudo/exit',
    sshPid: '/tmp/sudo/ssh.pid',
    prompt: 'sudo password for h: ',
    promptTimeoutSeconds: 150,
  })
  // The password is read without echo, from the terminal, into a shell variable.
  assert.match(script, /read -r -s -t 150 pw/)
  // It is piped to ssh; `printf` is a builtin, so the value never becomes argv.
  assert.match(script, /printf '%s\\n' "\$pw" \| \{/)
  assert.match(script, /set \+x \+v/)
  assert.match(script, /unset HISTFILE/)
  // Exit status is written last, after ssh (and its output) is complete, and
  // swapped in atomically so a poller never reads a half-written file.
  assert.match(script, /wait \$!; rc=\$\?/)
  assert.match(script, /mv "\$EXIT\.tmp" "\$EXIT"/)
})

test('sudo pipes the typed password to sudo stdin and returns the command result', async () => {
  const fakeSsh = await installFakeSsh()
  const fakeTerm = await installFakeTerminal({ password: 'fakepw' })
  process.env.FAKE_SSH_EXPECT_STDIN = 'fakepw'
  process.env.FAKE_SSH_STDOUT = 'root-only\n'
  try {
    const result = await runSudoCommand(target, { command: 'id -u', workdir: '/root', timeoutMs: 10_000 })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.code, 0)
    assert.equal(result.stdout, 'root-only\n')
    assert.doesNotMatch(result.stdout + result.stderr, /fakepw/, 'the password must not appear in the result')
    assert.equal((await fakeSsh.readLog()).length, 1, 'exactly one ssh call carries the sudo command')
  } finally {
    delete process.env.FAKE_SSH_EXPECT_STDIN
    delete process.env.FAKE_SSH_STDOUT
    await fakeTerm.cleanup()
    await fakeSsh.cleanup()
  }
})

test('a wrong password is reported as a non-zero command result', async () => {
  const fakeSsh = await installFakeSsh()
  const fakeTerm = await installFakeTerminal({ password: 'wrong' })
  process.env.FAKE_SSH_EXPECT_STDIN = 'right'
  process.env.FAKE_SSH_STDERR = 'fake ssh: unexpected stdin\n'
  try {
    const result = await runSudoCommand(target, { command: 'id', workdir: '/', timeoutMs: 10_000 })
    assert.equal(result.ok, true)
    assert.equal(result.code, 7)
    assert.match(result.stderr, /unexpected stdin/)
    assert.doesNotMatch(result.stdout + result.stderr, /wrong/)
  } finally {
    delete process.env.FAKE_SSH_EXPECT_STDIN
    delete process.env.FAKE_SSH_STDERR
    await fakeTerm.cleanup()
    await fakeSsh.cleanup()
  }
})

test('a missing terminal surfaces an error instead of blocking', async () => {
  const fakeSsh = await installFakeSsh()
  const previous = process.env.REMOTE_SSH_TERMINAL
  process.env.REMOTE_SSH_TERMINAL = 'remote-ssh-no-such-terminal-xyz'
  try {
    const result = await runSudoCommand(target, { command: 'id', workdir: '/', timeoutMs: 5000 })
    assert.equal(result.ok, false)
    assert.match(result.error, /cannot open a terminal for the sudo password/)
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SSH_TERMINAL
    else process.env.REMOTE_SSH_TERMINAL = previous
    await fakeSsh.cleanup()
  }
})

test('a terminal that never reports an exit times out', async () => {
  const fakeSsh = await installFakeSsh()
  const previous = process.env.REMOTE_SSH_TERMINAL
  process.env.REMOTE_SSH_TERMINAL = 'true' // exits without writing an exit file
  try {
    const result = await runSudoCommand(target, { command: 'id', workdir: '/', timeoutMs: 300 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SSH_TERMINAL
    else process.env.REMOTE_SSH_TERMINAL = previous
    await fakeSsh.cleanup()
  }
})
