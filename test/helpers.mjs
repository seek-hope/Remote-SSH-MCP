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
if (process.env.FAKE_SSH_MARK) {
  // sshRun's marker is random per call and embedded in the wrapped command;
  // echo that exact marker back so the exit code rides the expected line.
  const marker = wrapped.match(/__REMOTE_SSH_EXIT_[0-9a-f-]+__/)?.[0] || '__REMOTE_SSH_EXIT__'
  fs.writeSync(1, marker + process.env.FAKE_SSH_MARK + '\\n')
}
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

/**
 * installFakeTerminal — replaces REMOTE_SSH_TERMINAL with a launcher that runs
 * the generated terminal command and feeds `password` on its stdin, so the
 * sudo flow can run without a desktop session. The password is only ever held
 * by the fake terminal, never by the caller.
 */
export async function installFakeTerminal({ password = 'fakepw' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fake-terminal-'))
  const bin = join(dir, 'terminal.sh')
  await writeFile(bin, `#!/usr/bin/env bash\ncmd="\${@: -1}"\nprintf '%s\\n' ${JSON.stringify(password)} | bash -c "$cmd"\n`)
  await chmod(bin, 0o755)
  const previous = process.env.REMOTE_SSH_TERMINAL
  process.env.REMOTE_SSH_TERMINAL = `bash ${bin}`
  return {
    dir,
    async cleanup() {
      if (previous === undefined) delete process.env.REMOTE_SSH_TERMINAL
      else process.env.REMOTE_SSH_TERMINAL = previous
      await rm(dir, { recursive: true, force: true })
    },
  }
}
