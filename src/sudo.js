/**
 * sudo.js — run one command as root over SSH, with the sudo password typed by
 * the user in a new terminal.
 *
 * The password never reaches the MCP process, the model, argv or disk:
 *
 *   - a temporary terminal runs a short bash script that reads the password
 *     with `read -s` (no echo) into a local shell variable;
 *   - the variable is piped as the ssh process's stdin, which the remote
 *     command reads with `sudo -S` (password from stdin, no remote tty, so the
 *     password is never echoed back);
 *   - only the command's stdout, stderr and exit status are written to files
 *     in a 0700 temporary directory, which the MCP process reads and deletes.
 *
 * The terminal only communicates the command result through those files; the
 * service never sees the password itself. The SSH connection must already be
 * authenticated (the caller runs readyTarget first), because the terminal
 * uses BatchMode and never prompts for the SSH credentials.
 */

import { mkdtemp, chmod, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sshSpawn, shq, runInTerminal } from './ssh.js'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_PROMPT_TIMEOUT_MS = 150_000

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Bash script run by the temporary terminal. Exported for unit tests.
 *
 * `sshLine` is the fully quoted `ssh …` invocation that runs the remote sudo
 * command; the password is piped into it from the local `read -s`. The exit
 * status of ssh (and therefore of the remote command) is written to `exit`
 * after ssh has finished, so a reader that sees `exit` also sees complete
 * `out`/`err` files.
 */
export function buildSudoTerminalScript({ sshLine, out, err, exit, sshPid, prompt, promptTimeoutSeconds }) {
  return [
    'set +x +v',
    'umask 077',
    `OUT=${shq(out)}; ERR=${shq(err)}; EXIT=${shq(exit)}; SSHPID=${shq(sshPid)}`,
    `trap 'stty echo 2>/dev/null || true' EXIT`,
    `printf '%s\\n' ${shq(prompt)} >&2`,
    `if ! IFS= read -r -s -t ${promptTimeoutSeconds} pw; then`,
    `  printf '%s\\n' 'no sudo password entered' > "$ERR"`,
    `  printf '%s' 1 > "$EXIT.tmp"; mv "$EXIT.tmp" "$EXIT"`,
    `  exit 1`,
    `fi`,
    `printf '\\n' >&2`,
    `unset HISTFILE`,
    `printf '%s\\n' "$pw" | {`,
    `  ${sshLine} > "$OUT" 2> "$ERR" &`,
    `  echo $! > "$SSHPID"`,
    `  wait $!; rc=$?`,
    `  printf '%s' "$rc" > "$EXIT.tmp"; mv "$EXIT.tmp" "$EXIT"`,
    `}`,
    `unset pw`,
  ].join('\n')
}

async function waitForExit(path, { timeoutMs, signal }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return false
    try {
      await stat(path)
      return true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) return false
    await delay(100)
  }
}

async function killLocalSsh(pidFile) {
  let pid
  try {
    pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 0) return
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

/**
 * Run `command` as root on `target` through `sudo -S`.
 *
 * @param {object} target remote target (needs ssh, port, name)
 * @param {object} options
 * @param {string} options.command    command to run under sudo
 * @param {string} options.workdir    remote absolute working directory
 * @param {number} [options.timeoutMs]      overall budget, default 300s
 * @param {number} [options.promptTimeoutMs] password-entry budget, default 150s
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: true, code: number|null, stdout: string, stderr: string}
 *   | {ok: false, error: string, timedOut?: boolean, code?: number|null, stdout?: string, stderr?: string}>}
 */
export async function runSudoCommand(target, { command, workdir, timeoutMs = DEFAULT_TIMEOUT_MS, promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS, signal }) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-sudo-'))
  await chmod(dir, 0o700)
  const out = join(dir, 'stdout')
  const err = join(dir, 'stderr')
  const exit = join(dir, 'exit')
  const sshPid = join(dir, 'ssh.pid')
  try {
    // sudo reads the password from its stdin; the SSH command channel must not
    // allocate a remote tty, otherwise the password could be echoed back.
    const remote = `cd ${shq(workdir)} && sudo -S -p '' -- bash -c ${shq(command)}`
    const spec = await sshSpawn({ target: target.ssh, port: target.port, controlPersist: target.controlPersist }, remote)
    const sshLine = [spec.command, ...spec.args].map(shq).join(' ')
    const script = buildSudoTerminalScript({
      sshLine,
      out,
      err,
      exit,
      sshPid,
      prompt: `sudo password for ${target.name}: `,
      promptTimeoutSeconds: Math.max(1, Math.ceil(promptTimeoutMs / 1000)),
    })
    const opened = await runInTerminal(script)
    if (!opened.ok) {
      return { ok: false, error: `cannot open a terminal for the sudo password: ${opened.error}` }
    }
    const finished = await waitForExit(exit, { timeoutMs, signal })
    if (!finished) await killLocalSsh(sshPid)
    const [rawExit, stdout, stderr] = await Promise.all([
      readFile(exit, 'utf8').catch(() => ''),
      readFile(out, 'utf8').catch(() => ''),
      readFile(err, 'utf8').catch(() => ''),
    ])
    const code = Number.parseInt(rawExit.trim(), 10)
    if (!finished) {
      return {
        ok: false,
        timedOut: true,
        code: Number.isFinite(code) ? code : null,
        stdout,
        stderr,
        error: signal?.aborted ? 'aborted' : `sudo command did not finish within ${timeoutMs}ms`,
      }
    }
    return { ok: true, code: Number.isFinite(code) ? code : null, stdout, stderr }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
