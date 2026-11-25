/**
 * helpers.mjs — a configurable fake `ssh` for offline tests. It records its
 * argv (when FAKE_SSH_LOG is set) and can emit controlled stdout/stderr so the
 * ssh layer can be exercised without a remote host.
 */
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function remoteCommand(argv) {
  const outer = argv.at(-1) || ''
  const encoded = outer.match(/printf %s ([A-Za-z0-9+/=]+) \| base64 -d/)
  return encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : outer
}

const FAKE_SSH = `#!/usr/bin/env node
// Synchronous fd writes: process.stdout.write + process.exit can drop the tail
// of a large stream before the pipe drains, which would corrupt the test.
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\\n')
// resolveSshIdentity timeout tests: emit a complete (hold) or partial
// (partial) -G answer, then keep the pipe open past the caller's deadline.
if (argv.includes('-G') && process.env.FAKE_SSH_G_MODE === 'split-utf8') {
  // Split the UTF-8 bytes of "héllo"/"usér" across pipe writes.
  fs.writeSync(1, Buffer.from('hostname h', 'utf8'))
  fs.writeSync(1, Buffer.from([0xc3]))
  // Block (without timers) so the bytes reach the pipe as separate chunks.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
  fs.writeSync(1, Buffer.concat([
    Buffer.from([0xa9]),
    Buffer.from('llo\\nuser us', 'utf8'),
    Buffer.from([0xc3, 0xa9]),
    Buffer.from('r\\nport 22\\n', 'utf8'),
  ]))
} else if (argv.includes('-G') && process.env.FAKE_SSH_G_MODE === 'controlpath-stdin') {
  // Blocks until stdin is closed/ignored; verifies the -G probe ignores stdin.
  try { fs.readFileSync(0) } catch {}
  fs.writeSync(1, 'controlpath ' + (process.env.FAKE_SSH_CONTROL_PATH || '/tmp/remote-ssh-cp') + '\\n')
  process.exit(0)
} else if (argv.includes('-G') && process.env.FAKE_SSH_G_MODE === 'controlpath-ok') {
  fs.writeSync(1, 'controlpath ' + (process.env.FAKE_SSH_CONTROL_PATH || '/tmp/remote-ssh-cp') + '\\n')
  process.exit(0)
} else if (argv.includes('-G') && process.env.FAKE_SSH_G_MODE === 'controlpath-truncated') {
  // A clean close with a controlpath line lacking its terminating newline.
  fs.writeSync(1, 'controlpath /tmp/remote-ssh-truncated')
} else if (argv.includes('-G') && process.env.FAKE_SSH_G_MODE) {
  const mode = process.env.FAKE_SSH_G_MODE
  fs.writeSync(1, mode === 'partial'
    ? 'user testuser\\nhostname foo\\n'
    : mode === 'truncated'
      ? 'hostname h\\nuser testuser\\nport 22'
      : mode === 'nouser' || mode === 'nouser-close'
        ? 'hostname h\\nport 22\\n'
        : mode === 'crlf'
          ? 'hostname h\\r\\nuser testuser\\r\\nport 22\\r\\n'
          : 'hostname h\\nuser testuser\\nport 22\\n')
  if (mode === 'partial') {
    // Block without timers or CPU until the resolver's SIGKILL.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  } else if (mode === 'nouser-close') {
    // Clean close with an incomplete answer: exercises the post-close check.
    process.exit(0)
  } else {
    const holder = require('node:child_process').spawn('sleep', ['2'], { stdio: ['ignore', 'inherit', 'ignore'] })
    holder.unref()
    setTimeout(() => process.exit(0), 0)
  }
}
const outer = argv.at(-1) || ''
const encoded = outer.match(/printf %s ([A-Za-z0-9+/=]+) \\| base64 -d/)
const wrapped = encoded ? Buffer.from(encoded[1], 'base64').toString('utf8') : outer
// Optional: prove the password was piped to sudo's stdin without logging it.
// Only the sudo invocation reads stdin, so other calls never block on it.
const expect = process.env.FAKE_SSH_EXPECT_STDIN
if (expect !== undefined && wrapped.includes('sudo -S')) {
  let data = ''
  try { data = fs.readFileSync(0, 'utf8') } catch {}
  if (data.trim() !== expect) { fs.writeSync(2, 'fake ssh: unexpected stdin'); process.exit(7) }
}
// Selective failure: invocations whose argv contains FAKE_SSH_FAIL_MATCH exit
// with FAKE_SSH_FAIL_EXIT and optional FAKE_SSH_FAIL_STDERR (others proceed).
const failMatch = process.env.FAKE_SSH_FAIL_MATCH
if (failMatch && (argv.join('\\n') + '\\n' + wrapped).includes(failMatch)) {
  if (process.env.FAKE_SSH_FAIL_STDERR) fs.writeSync(2, process.env.FAKE_SSH_FAIL_STDERR)
  process.exit(Number(process.env.FAKE_SSH_FAIL_EXIT || '1'))
}
// A local descendant that inherits stderr and outlives ssh keeps the pipe
// open; used to prove timeouts still settle.
if (process.env.FAKE_SSH_HOLD_STDERR) {
  const { spawn } = require('node:child_process')
  const holder = spawn('sleep', ['2'], { stdio: ['ignore', 'ignore', 'inherit'] })
  holder.unref()
}
const big = Number(process.env.FAKE_SSH_BIG || '0')
if (big > 0) {
  const chunk = Buffer.alloc(65536, 0x41)
  let w = 0
  while (w < big) { const n = Math.min(65536, big - w); fs.writeSync(1, n === 65536 ? chunk : chunk.subarray(0, n)); w += n }
  if (process.env.FAKE_SSH_TAIL) fs.writeSync(1, process.env.FAKE_SSH_TAIL)
}
if (process.env.FAKE_SSH_STDOUT) {
  // __SEP__ is replaced by the read tool's per-call separator, extracted from
  // the wrapped remote command (mirrors the FAKE_SSH_MARK mechanism).
  let out = process.env.FAKE_SSH_STDOUT
  const sep = wrapped.match(/__REMOTE_SSH_SEP_[0-9a-f]+__/)?.[0]
  if (sep) out = out.split('__SEP__').join(sep)
  out = out.split('__NUL__').join('\0')
  fs.writeSync(1, out)
}
if (process.env.FAKE_SSH_SPLIT_OUTPUT) {
  // Two writes with a pause: exercises streaming boundaries/carry logic.
  const buf = Buffer.from(process.env.FAKE_SSH_SPLIT_OUTPUT, 'utf8')
  fs.writeSync(1, buf.subarray(0, 15))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  fs.writeSync(1, buf.subarray(15))
}
if (process.env.FAKE_SSH_MARK) {
  // sshRun's marker is random per call and embedded in the wrapped command;
  // echo that exact marker back so the exit code rides the expected line.
  const marker = wrapped.match(/__REMOTE_SSH_EXIT_[0-9a-f-]+__/)?.[0] || '__REMOTE_SSH_EXIT__'
  fs.writeSync(1, marker + process.env.FAKE_SSH_MARK + '\\n')
}
if (process.env.FAKE_SSH_MID_STDERR) {
  // 8 KiB filler swallows the phrase from the retained head; invalid bytes
  // after it make the decoded text expand past the stderr cap.
  fs.writeSync(2, Buffer.from('A'.repeat(8192) + ' Host key verification failed. '))
  fs.writeSync(2, Buffer.alloc(42000, 0x80))
}
if (process.env.FAKE_SSH_HEAD_STDERR) fs.writeSync(2, process.env.FAKE_SSH_HEAD_STDERR)
const bigErr = Number(process.env.FAKE_SSH_BIG_ERR || '0')
if (bigErr > 0) {
  const chunk = Buffer.alloc(65536, 0x45)
  let w = 0
  while (w < bigErr) { const n = Math.min(65536, bigErr - w); fs.writeSync(2, n === 65536 ? chunk : chunk.subarray(0, n)); w += n }
}
if (process.env.FAKE_SSH_STDERR) fs.writeSync(2, process.env.FAKE_SSH_STDERR)
process.exit(Number(process.env.FAKE_SSH_EXIT || '0'))
`

export async function installFakeSsh() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-ssh-'))
  const bin = join(dir, 'ssh')
  await writeFile(bin, FAKE_SSH)
  await chmod(bin, 0o755)
  const log = join(dir, 'argv.log')
  const previousPath = process.env.PATH
  process.env.FAKE_SSH_LOG = log
  process.env.PATH = `${dir}:${process.env.PATH}`
  return {
    dir,
    log,
    async readLog() {
      try {
        const raw = await readFile(log, 'utf8')
        return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    async cleanup() {
      delete process.env.FAKE_SSH_LOG
      process.env.PATH = previousPath
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Execute the generated remote command locally, only for temp-directory tests. */
export async function installLocalSsh() {
  const fake = await installFakeSsh()
  // A faithful stand-in for sshd's session stdin: Node's own stdio "pipe" is a
  // socketpair (reopening it via /proc fails with ENXIO), while a real remote
  // shell gets an OS pipe. The bridge copies the socketpair through os.pipe().
  const bridge = join(fake.dir, 'bridge.py')
  await writeFile(bridge, `import os, subprocess, sys
cmd = sys.argv[1]
r, w = os.pipe()
child = subprocess.Popen(['sh', '-c', cmd], stdin=r)
os.close(r)
try:
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(w, data)
finally:
    os.close(w)
sys.exit(child.wait())
`)
  await writeFile(join(fake.dir, 'ssh'), `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const argv = process.argv.slice(2)
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + '\\n')
if (argv.includes('-G')) {
  // One -G call fails: the first process to unlink the marker exits 1, so a
  // test can run concurrent sudo calls with mixed resolved/unresolved identity.
  const failFile = process.env.FAKE_SSH_G_FAIL_FILE
  if (failFile) {
    try {
      fs.unlinkSync(failFile)
      process.exit(1)
    } catch {}
  }
  const host = process.env.FAKE_SSH_IDENTITY_HOST || 'h'
  const user = process.env.FAKE_SSH_IDENTITY_USER || 'testuser'
  const port = process.env.FAKE_SSH_IDENTITY_PORT || '22'
  process.stdout.write('hostname ' + host + '\\nuser ' + user + '\\nport ' + port + '\\n')
  process.exit(0)
}
const child = spawn('python3', [${JSON.stringify(bridge)}, argv.at(-1)], { stdio: 'inherit' })
child.on('error', () => process.exit(1))
child.on('close', (code) => process.exit(code ?? 1))
`, { mode: 0o755 })
  return fake
}

/**
 * installFakeTerminal — replaces REMOTE_SSH_TERMINAL with a launcher that runs
 * the generated terminal command and feeds `password` on its stdin, so the
 * sudo flow can run without a desktop session. The password is passed through
 * the environment (never written into the script or interpolated into shell
 * code); every invocation is logged so tests can assert that a cached
 * credential avoided another prompt.
 */
export async function installFakeTerminal({ password = 'fakepw', delayMs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-terminal-'))
  const bin = join(dir, 'terminal.sh')
  const log = join(dir, 'invocations.log')
  const modeLog = join(dir, 'socket-mode.log')
  const delay = (Math.max(0, Number(delayMs) || 0) / 1000).toFixed(3)
  await writeFile(bin, `#!/usr/bin/env bash\ncmd="\${@: -1}"\nsleep ${delay}\nsock=$(printf '%s' "$cmd" | grep -o "[^ '\\"]*askpass[.]sock" | head -n 1)\nif [ -n "$sock" ]; then { stat -c '%a' "$sock" 2>/dev/null || stat -f '%Lp' "$sock" 2>/dev/null; } >> ${JSON.stringify(modeLog)}; fi\nprintf 'prompt\\n' >> ${JSON.stringify(log)}\nprintf '%s\\n' "$FAKE_TERMINAL_PASSWORD" | /bin/bash -c "$cmd"\n`)
  await chmod(bin, 0o700)
  const previousTerminal = process.env.REMOTE_SSH_TERMINAL
  const previousPassword = process.env.FAKE_TERMINAL_PASSWORD
  process.env.REMOTE_SSH_TERMINAL = `bash ${bin}`
  process.env.FAKE_TERMINAL_PASSWORD = password
  return {
    dir,
    log,
    modeLog,
    async readLog() {
      try {
        const raw = await readFile(log, 'utf8')
        return raw.trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    async cleanup() {
      if (previousTerminal === undefined) delete process.env.REMOTE_SSH_TERMINAL
      else process.env.REMOTE_SSH_TERMINAL = previousTerminal
      if (previousPassword === undefined) delete process.env.FAKE_TERMINAL_PASSWORD
      else process.env.FAKE_TERMINAL_PASSWORD = previousPassword
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * A fake sudo for tests that execute the real remote wrapper locally
 * (installLocalSsh). It emulates the two v-modes and runs the command the
 * service asks sudo to run:
 *   - `-n -v` succeeds only with FAKE_SUDO_TICKET=1, or after a successful
 *     `-S -v` (tracked by a state file);
 *   - `-S -v` reads one password line and compared it with FAKE_SUDO_PASSWORD;
 *     FAKE_SUDO_SKIP_READ simulates NOPASSWD (success without reading);
 *   - `-n -- <argv>` execs the command.
 * FAKE_SUDO_POLICY makes every invocation a policy refusal.
 */
const FAKE_SUDO = `#!/bin/bash
logline="$*"
printf '%s\\n' "\${logline//$'\\n'/ }" >> "$FAKE_SUDO_LOG"
readflag=0; nflag=0; vflag=0
for arg in "$@"; do
  if [ "$arg" = "--" ]; then break; fi
  case "$arg" in
    -S) readflag=1 ;;
    -n) nflag=1 ;;
    -v) vflag=1 ;;
  esac
done
# Timestamps are keyed by the parent shell, like sudo's no-tty fallback: the
# state only matches within the same remote shell, never across SSH calls.
# Per-parent files keep concurrent wrappers from clobbering each other.
statefile="$FAKE_SUDO_STATE.$PPID"
ticket() { [ -f "$statefile" ]; }
if [ "\${FAKE_SUDO_POLICY:-0}" = 1 ]; then
  printf 'sudo: user is not in the sudoers file.  This incident will be reported.\\n' >&2
  exit 1
fi
if [ "$vflag" = 1 ]; then
  if [ "$readflag" = 1 ]; then
    if [ "\${FAKE_SUDO_SKIP_READ:-0}" = 1 ]; then : > "$statefile"; exit 0; fi
    if ! IFS= read -r pw; then printf 'sudo: no password read\\n' >&2; exit 1; fi
    if [ "$pw" = "\${FAKE_SUDO_PASSWORD:-}" ]; then : > "$statefile"; exit 0; fi
    printf 'sudo: 1 incorrect password attempt\\n' >&2
    exit 1
  fi
  if ticket; then
    if [ "\${FAKE_SUDO_NO_TICKET:-0}" = 1 ]; then printf 'sudo: a password is required\\n' >&2; exit 1; fi
    exit 0
  fi
  if [ "\${FAKE_SUDO_FAIL_AFTER_PROBE:-0}" = 1 ]; then
    counter="$FAKE_SUDO_STATE.count"
    n=$(cat "$counter" 2>/dev/null || echo 0)
    n=$((n + 1))
    printf '%s' "$n" > "$counter"
    if [ "$n" -gt 1 ]; then printf 'sudo: a password is required\\n' >&2; exit 1; fi
  fi
  if [ "\${FAKE_SUDO_TICKET:-0}" = 1 ]; then : > "$statefile"; exit 0; fi
  printf 'sudo: a password is required\\n' >&2
  exit 1
fi
  if [ "$nflag" = 1 ]; then
    # A denied wrapper echoes the whole command line, including the marker
    # tokens; the service must still report that the command never ran.
    if [ "\${FAKE_SUDO_DENY_WRAPPER:-0}" = 1 ]; then
      printf 'Sorry, user test is not allowed to execute '\''%s'\'' as root on host.\\n' "$*" >&2
      exit 1
    fi
    # A command run needs NOPASSWD (the probe succeeded) or a ticket keyed to
    # this parent. The latter is what a real ppid-keyed sudo checks, so an
    # exec-optimized final sudo (different parent) fails this test.
    if [ "\${FAKE_SUDO_TICKET:-0}" = 1 ] || ticket; then
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    if [ "$1" = "--" ]; then shift; fi
    exec "$@"
  fi
  printf 'sudo: a password is required\\n' >&2
  exit 1
fi
printf 'fake sudo: unsupported invocation: %s\\n' "$*" >&2
exit 1
`

export async function installFakeSudo({
  dir,
  password = '',
  ticket = false,
  skipRead = false,
  noTicket = false,
  policy = false,
  failAfterProbe = false,
  denyWrapper = false,
} = {}) {
  const ownsDir = dir === undefined
  const fakeDir = dir ?? await mkdtemp(join(tmpdir(), 'dsh-fake-sudo-'))
  const bin = join(fakeDir, 'sudo')
  const log = join(fakeDir, 'sudo.log')
  const state = join(fakeDir, 'sudo.state')
  await writeFile(bin, FAKE_SUDO)
  await chmod(bin, 0o755)
  await rm(state, { force: true })
  await rm(`${state}.count`, { force: true })
  const previous = {
    PATH: process.env.PATH,
    FAKE_SUDO_LOG: process.env.FAKE_SUDO_LOG,
    FAKE_SUDO_STATE: process.env.FAKE_SUDO_STATE,
    FAKE_SUDO_PASSWORD: process.env.FAKE_SUDO_PASSWORD,
    FAKE_SUDO_TICKET: process.env.FAKE_SUDO_TICKET,
    FAKE_SUDO_SKIP_READ: process.env.FAKE_SUDO_SKIP_READ,
    FAKE_SUDO_NO_TICKET: process.env.FAKE_SUDO_NO_TICKET,
    FAKE_SUDO_POLICY: process.env.FAKE_SUDO_POLICY,
    FAKE_SUDO_FAIL_AFTER_PROBE: process.env.FAKE_SUDO_FAIL_AFTER_PROBE,
    FAKE_SUDO_DENY_WRAPPER: process.env.FAKE_SUDO_DENY_WRAPPER,
  }
  process.env.PATH = `${fakeDir}:${process.env.PATH}`
  process.env.FAKE_SUDO_LOG = log
  process.env.FAKE_SUDO_STATE = state
  process.env.FAKE_SUDO_PASSWORD = password
  process.env.FAKE_SUDO_TICKET = ticket ? '1' : '0'
  process.env.FAKE_SUDO_SKIP_READ = skipRead ? '1' : '0'
  process.env.FAKE_SUDO_NO_TICKET = noTicket ? '1' : '0'
  process.env.FAKE_SUDO_POLICY = policy ? '1' : '0'
  process.env.FAKE_SUDO_FAIL_AFTER_PROBE = failAfterProbe ? '1' : '0'
  process.env.FAKE_SUDO_DENY_WRAPPER = denyWrapper ? '1' : '0'
  return {
    dir: fakeDir,
    log,
    state,
    async readLog() {
      try {
        const raw = await readFile(log, 'utf8')
        return raw.trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
    async cleanup() {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (ownsDir) await rm(fakeDir, { recursive: true, force: true })
    },
  }
}
