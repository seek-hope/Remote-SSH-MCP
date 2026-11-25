/**
 * sudo.js — run one command as root over SSH, reusing the sudo password for a
 * short, configurable window.
 *
 * Each call first runs an **authentication-only** probe, `sudo -n -v`, which
 * never executes user code. If it succeeds (NOPASSWD or a valid global sudo
 * ticket), the command runs in a second SSH invocation with `sudo -n`; no
 * password is sent. Otherwise:
 *
 *   - the password comes from the process-local cache (src/sudocache.js) when
 *     one was entered for the same SSH destination within the TTL (default
 *     20 minutes);
 *   - on a cache miss a terminal on the machine running this service prompts
 *     with `read -s` and delivers the password to this process over a private
 *     Unix socket in a 0700 temporary directory. Nothing is written to disk,
 *     logged, echoed, or placed in argv.
 *
 * The password is sent only to `sudo -S -p '' -v`, which also runs no user
 * code. After it succeeds a second `sudo -n -v` proves the remote sudo kept a
 * credential ticket; any password line sudo did not need (NOPASSWD or a ticket
 * that appeared meanwhile) is then consumed by a short-lived `bash`, and only
 * then does the command run, via `sudo -n` with stdin `/dev/null`. The
 * authenticating calls and the command are children of the same remote
 * subshell, so ppid-keyed sudo tickets apply (the wrapper ends with an
 * explicit exit so the shell cannot exec-optimize the final sudo into a
 * different parent).
 *
 * Every marker uses an independent random token. The wrapper's own markers
 * signal authentication/ticket/drain/cd failures; a START/POST pair proves the
 * user command was actually reached, so a failed final `sudo -n` is reported
 * as an error instead of a command exit. User code never runs before
 * authentication, and there is no automatic retry after an authentication
 * failure, so a command cannot cause a second execution of itself.
 *
 * The password therefore never appears in tool arguments, results, logs, argv
 * or files. The cache holds a copy in process memory for at most its TTL; the
 * per-call copy is wiped once SSH has accepted stdin. The remote host must
 * keep a credential ticket (a nonzero sudoers `timestamp_timeout`) or grant
 * NOPASSWD; `timestamp_timeout=0` is reported as unsupported instead of
 * running a command while the password is still readable.
 *
 * A timeout or cancellation only terminates the local SSH process; the remote
 * command may continue running.
 */

import { createServer } from 'node:net'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveSshIdentity, sshRun, shq, runInTerminal } from './ssh.js'
import {
  dropCachedSudoPassword,
  getCachedSudoPasswordEntry,
  setCachedSudoPassword,
  sudoCacheGeneration,
  sudoCacheKey,
  sudoCacheTtlMs,
} from './sudocache.js'

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_PROMPT_TIMEOUT_MS = 150_000
/** A sudo password is short; anything larger is a broken local client. */
const MAX_PASSWORD_BYTES = 8 * 1024
/** How long the drain waits for the password line/EOF before refusing. */
const DRAIN_TIMEOUT_SECONDS = 5

/** sudo policy/configuration refusals a password cannot fix. */
const POLICY_RE = /not in the sudoers file|not allowed to execute|command not allowed|no tty present|a terminal is required|must have a tty|requiretty|no askpass program/i
/** The remote shell could not find sudo itself. */
const SETUP_RE = /(?:^|\n)(?:sh|bash): (?:sudo: )?(?:command )?not found|sudo: (?:command )?not found/i

/**
 * Node client run inside the terminal to hand the password to this process.
 * It reads stdin (the `read -s` value, never argv), sends it over the private
 * Unix socket, and exits. The code avoids single quotes so it survives `shq`.
 */
const ASKPASS_CLIENT = 'const net=require("net"),fs=require("fs");const s=net.connect(process.argv[1]);s.on("error",()=>process.exit(1));s.end(fs.readFileSync(0),()=>process.exit(0))'

/**
 * Bash script run by the temporary terminal. Exported for unit tests.
 *
 * The prompt and the password are handled entirely by the terminal: the
 * password is read without echo into a shell variable, then piped to the
 * local node client (a builtin printf, so it never becomes argv). On failure
 * the client still reports `ERR`, so the service fails fast instead of
 * waiting out the prompt timeout. Nothing secret touches the filesystem.
 */
export function buildSudoPromptScript({ socket, prompt, promptTimeoutSeconds, nodePath = process.execPath }) {
  const askpass = [shq(nodePath), '-e', shq(ASKPASS_CLIENT), shq(socket)].join(' ')
  return [
    'set +x +v',
    'umask 077',
    `trap 'stty echo 2>/dev/null || true' EXIT`,
    `printf '%s\\n' ${shq(prompt)} >&2`,
    `if ! IFS= read -r -s -t ${promptTimeoutSeconds} pw; then`,
    `  printf '\\n' >&2`,
    `  printf 'ERR\\n' | ${askpass}`,
    `  exit 1`,
    `fi`,
    `printf '\\n' >&2`,
    `unset HISTFILE`,
    `printf 'OK\\n%s' "$pw" | ${askpass}`,
    `unset pw`,
  ].join('\n')
}

/** Strip control, zero-width and bidi characters from text shown in a terminal. */
function promptText(value, limit) {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/g, '?')
  if (text.length <= limit) return text
  let cut = limit
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return text.slice(0, cut)
}

/** Parse `OK\n<password>` / `ERR\n` from the terminal's socket payload. */
function parsePasswordPayload(outcome) {
  if (!outcome.ok) return outcome
  const { data } = outcome
  try {
    const newline = data.indexOf(0x0a)
    if (newline === -1) return { ok: false, error: 'the terminal did not report a sudo password status' }
    const status = data.subarray(0, newline).toString('latin1')
    const password = data.subarray(newline + 1)
    if (status === 'ERR') return { ok: false, error: 'no sudo password entered' }
    if (status !== 'OK') return { ok: false, error: 'the terminal sent an invalid sudo password response' }
    if (password.length === 0) return { ok: false, error: 'an empty sudo password was entered' }
    return { ok: true, password: Buffer.from(password) }
  } finally {
    // The private copy above is the only survivor; wipe the raw payload.
    data.fill(0)
  }
}

/**
 * Open a terminal, wait for the password over a private Unix socket, and
 * resolve with a private copy. The socket directory is 0700 and removed in
 * every path; the payload is bounded and never written to a file. Never
 * rejects: a filesystem or launcher failure becomes an error result, so one
 * failed shared prompt cannot strand the callers waiting on it.
 * @returns {Promise<{ok: true, password: Buffer} | {ok: false, error: string}>}
 */
async function promptForPassword(target, { promptTimeoutMs, signal }) {
  const abandoned = { ok: false, error: 'the sudo password prompt was abandoned' }
  if (signal?.aborted) return abandoned
  let dir
  let server
  let timer
  let raceLost = false
  const connections = new Set()
  // Register the abort listener before the (possibly slow) terminal launch:
  // addEventListener never fires for an already-aborted signal, and the
  // terminal can outlive the request.
  let resolveAbort
  const aborted = new Promise((resolve) => { resolveAbort = () => resolve(abandoned) })
  const onAbort = () => {
    raceLost = true
    resolveAbort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    dir = await mkdtemp(join(tmpdir(), 'remote-ssh-sudo-'))
    await chmod(dir, 0o700)
    if (signal?.aborted) return abandoned
    const socketPath = join(dir, 'askpass.sock')
    const seconds = Math.max(1, Math.ceil(promptTimeoutMs / 1000))
    const prompt = sudoPasswordPrompt(target)

    const received = new Promise((resolve) => {
      let settled = false
      const settle = (value) => {
        if (settled) return false
        settled = true
        resolve(value)
        return true
      }
      server = createServer((connection) => {
        connections.add(connection)
        connection.on('close', () => connections.delete(connection))
        const chunks = []
        let size = 0
        const discard = () => {
          for (const chunk of chunks) chunk.fill(0)
          chunks.length = 0
        }
        connection.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_PASSWORD_BYTES) {
            chunk.fill(0)
            connection.destroy()
            discard()
            settle({ ok: false, error: 'the terminal sent an oversized sudo password payload' })
            return
          }
          chunks.push(chunk)
        })
        connection.on('end', () => {
          const data = Buffer.concat(chunks)
          discard()
          // A late connection after the timer/abort won must not leave its
          // secret in a dropped Buffer.
          if (raceLost || !settle({ ok: true, data })) data.fill(0)
        })
        connection.on('close', () => discard())
        connection.on('error', () => {
          discard()
          settle({ ok: false, error: 'the local sudo password channel failed' })
        })
      })
      server.once('error', (error) => settle({ ok: false, error: `cannot open the local sudo password socket: ${error.message}` }))
    })

    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
        server.listen(socketPath)
      })
    } catch (error) {
      return { ok: false, error: `cannot open the local sudo password socket: ${error.message}` }
    }

    if (signal?.aborted) return abandoned
    const opened = await Promise.race([
      runInTerminal(buildSudoPromptScript({
        socket: socketPath,
        prompt,
        promptTimeoutSeconds: seconds,
      })),
      aborted,
    ])
    if (opened === abandoned) return abandoned
    if (!opened.ok) return { ok: false, error: `cannot open a terminal for the sudo password: ${opened.error}` }

    // The terminal's `read -t` is rounded up to whole seconds; the extra
    // second lets a last-moment delivery reach the cache for other callers.
    const timed = new Promise((resolve) => {
      timer = setTimeout(() => {
        raceLost = true
        resolve({
          ok: false,
          error: `no sudo password was entered within ${seconds}s`,
        })
      }, Math.max(1, promptTimeoutMs) + 1000)
      timer.unref()
    })
    const outcome = await Promise.race([received, timed, aborted])
    return parsePasswordPayload(outcome)
  } catch (error) {
    return { ok: false, error: `the sudo password prompt failed: ${error?.message ?? error}` }
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // A rogue local client must not keep the prompt (and its Map entry) alive.
    for (const connection of connections) connection.destroy()
    try { server?.close() } catch { /* already closed */ }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** In-flight terminal prompts, one per SSH destination. */
const pendingPrompts = new Map() // key -> { promise, controller, waiters }

/** Await a shared prompt; an abort detaches only this caller. */
function waitForPrompt(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve({ ok: false, error: 'aborted' })
  return new Promise((resolve) => {
    const onAbort = () => resolve({ ok: false, error: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    const finish = (result) => {
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    promise.then(finish, (error) => finish({ ok: false, error: error?.message ?? String(error) }))
  })
}

/**
 * Bound one caller's wait by its own password budget. Each caller of a shared
 * prompt enforces its own deadline, so a short-lived caller never truncates
 * the prompt for a caller with a longer budget.
 */
function withPromptDeadline(promise, promptTimeoutMs) {
  const seconds = Math.max(1, Math.ceil(promptTimeoutMs / 1000))
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `no sudo password was entered within ${seconds}s` }),
        Math.max(1, promptTimeoutMs),
      )
      timer.unref()
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * Resolve a password for `target`: a private copy from the cache, or one
 * entered in a terminal. Concurrent misses on one destination share a single
 * terminal prompt; the winner caches the password, waiters read the cache.
 * The returned Buffer MUST be wiped by the caller.
 */
async function obtainPassword(target, { ttlMs, promptTimeoutMs, identity, signal }) {
  const key = sudoCacheKey(target)

  // With caching disabled there is nowhere to publish a shared result, so
  // each call prompts on its own. Its internal timer is sized by this caller's
  // budget, so the prompt cannot outlive it by more than the delivery grace.
  if (ttlMs <= 0) {
    // No shared cache is involved, so give this prompt its own controller and
    // abort it when the deadline wins; a password delivered in the grace
    // second is then wiped instead of left in a dropped Buffer.
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      const outcome = await withPromptDeadline(
        waitForPrompt(promptForPassword(target, { promptTimeoutMs, signal: controller.signal }), signal),
        promptTimeoutMs,
      )
      return outcome.ok ? { ...outcome, source: 'prompt' } : outcome
    } finally {
      controller.abort()
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  // A disabled cache must never satisfy a call, even if an entry from an
  // earlier TTL setting is still present.
  const cached = getCachedSudoPasswordEntry(key, { identity })
  if (cached !== undefined) return { ok: true, password: cached.password, token: cached.token, source: 'cache' }

  // Share a prompt only among callers with the same resolved identity: a
  // caller whose `ssh -G` failed must not join (and then miss) a prompt whose
  // credential is stored for another identity, and two identities must not
  // overwrite each other's cache slot.
  const promptKey = JSON.stringify([key, identity ?? null])
  let entry = pendingPrompts.get(promptKey)
  if (entry === undefined) {
    const controller = new AbortController()
    const generation = sudoCacheGeneration(key)
    entry = { controller, waiters: 0, promise: undefined }
    entry.promise = promptForPassword(target, {
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      signal: controller.signal,
    }).then((outcome) => {
      if (!outcome.ok) return outcome
      // Do not resurrect a credential cleared while the prompt was open
      // (target removed, ssh/port changed, disconnect, shutdown).
      const stored = setCachedSudoPassword(key, outcome.password, ttlMs, Date.now(), generation, identity)
      outcome.password.fill(0)
      return stored ? { ok: true } : { ok: false, error: 'the sudo password cache was cleared while the prompt was open' }
    })
    pendingPrompts.set(promptKey, entry)
    entry.promise.finally(() => {
      if (pendingPrompts.get(promptKey) === entry) pendingPrompts.delete(promptKey)
    }).catch(() => {})
  }

  entry.waiters += 1
  let outcome
  try {
    outcome = await withPromptDeadline(waitForPrompt(entry.promise, signal), promptTimeoutMs)
  } finally {
    entry.waiters -= 1
    // The last caller gave up: stop the prompt instead of leaving a socket
    // server and a Map entry alive until the terminal times out.
    if (entry.waiters === 0 && pendingPrompts.get(promptKey) === entry) {
      pendingPrompts.delete(promptKey)
      entry.controller.abort()
    }
  }
  if (!outcome.ok) return outcome
  const stored = getCachedSudoPasswordEntry(key, { identity })
  if (stored === undefined) {
    return { ok: false, error: `the cached sudo password for "${target.name}" was cleared or rejected before it could be used; retry the call` }
  }
  return { ok: true, password: stored.password, token: stored.token, source: 'prompt' }
}

/**
 * Terminal prompt text: show the target name and the configured destination
 * (with a separate port label so IPv6 is not ambiguous), avoiding a duplicate
 * when the name defaults to the destination.
 */
export function sudoPasswordPrompt(target) {
  // Leave room for the port label so a long destination cannot truncate it.
  const base = promptText(target.ssh, 100)
  const where = target.port !== undefined ? `${base} (port ${target.port})` : base
  return target.name === target.ssh
    ? `sudo password for ${where}: `
    : `sudo password for ${promptText(target.name, 80)} (${where}): `
}

/**
 * The bash sudo runs. The user command is passed as an argument and evaluated
 * after stdin is reset, so the outer wrapper never has to parse it (a syntax
 * error is a command failure, not an authentication failure), and the command
 * cannot read a leftover password from the SSH stdin pipe. START/POST prove
 * the command was reached: a failed final `sudo -n` prints neither.
 */
function innerScript(cdMark, startMark, postMark) {
  return [
    '__remote_ssh_cmd=$1',
    '__remote_ssh_dir=$2',
    'set --',
    `cd "$__remote_ssh_dir" || { printf '\\n%s\\n' ${shq(cdMark)} >&2; exit 125; }`,
    'exec 0</dev/null',
    `printf '\\n%s\\n' ${shq(startMark)} >&2`,
    'eval "$__remote_ssh_cmd"',
    '__remote_ssh_rc=$?',
    `printf '\\n%s\\n' ${shq(postMark)} >&2`,
    'exit "$__remote_ssh_rc"',
  ].join('\n')
}

/**
 * Build the remote command.
 * - probe: `sudo -n -v` only. It runs no user code, so nothing can forge its
 *   result or be executed twice.
 * - command: `sudo -n` (a valid NOPASSWD rule or global ticket was proven by
 *   the probe). A failure here runs no user code either; START/POST tell the
 *   caller whether the command was reached, and there is no password retry.
 * - password: `sudo -S -v` consumes the password (no user code), a second
 *   `-n -v` proves a ticket was retained, any unconsumed line is drained, and
 *   only then the command runs with `sudo -n`.
 * The final sudo is followed by an explicit exit so the shell cannot
 * exec-optimize it into a different parent (which would break ppid tickets).
 */
function remoteSudoScript({ command, workdir, mode, marks }) {
  const run = [
    `sudo -n -- bash -c ${shq(innerScript(marks.cd, marks.start, marks.post))} bash ${shq(command)} ${shq(workdir)}`,
    '__remote_ssh_rc=$?',
    'exit "$__remote_ssh_rc"',
  ].join('\n')
  if (mode === 'probe') {
    // A positive marker plus exit 0: a same-user process that kills the probe
    // subshell after `-v` succeeded cannot turn that into a false success.
    return [
      `if LC_ALL=C sudo -n -v </dev/null; then printf '\\n%s\\n' ${shq(marks.probeOk)} >&2; exit 0; fi`,
      `printf '\\n%s\\n' ${shq(marks.probe)} >&2`,
      'exit 96',
    ].join('\n')
  }
  if (mode === 'command') {
    // The probe ran in a different shell, so re-check in this one before the
    // final sudo. A config that cannot run `-v` must not reach the command.
    return [
      `LC_ALL=C sudo -n -v || { printf '\\n%s\\n' ${shq(marks.ticket)} >&2; exit 98; }`,
      run,
    ].join('\n')
  }
  const drain = `bash -c 'IFS= read -r -t ${DRAIN_TIMEOUT_SECONDS} __remote_ssh_drain'`
  return [
    // Also drain on failure paths: if sudo did not read the password, do not
    // leave it in the session pipe while the wrapper exits.
    `LC_ALL=C sudo -S -p '' -v || { ${drain}; printf '\\n%s\\n' ${shq(marks.auth)} >&2; exit 97; }`,
    `LC_ALL=C sudo -n -v || { ${drain}; printf '\\n%s\\n' ${shq(marks.ticket)} >&2; exit 98; }`,
    // `read` returns 0 (line), 1 (EOF), >128 (timeout). Anything else means
    // the drain itself failed (missing/shadowed bash, 126/127): refuse to run
    // user code while the password may still be in the pipe.
    `${drain}; drain=$?`,
    'case "$drain" in 0|1) ;; *)',
    `  printf '\\n%s\\n' ${shq(marks.drain)} >&2`,
    '  exit 99',
    '  ;;',
    'esac',
    run,
  ].join('\n')
}

/** Remove marker lines (and the blank line their printf prefix leaves). */
function stripMarks(stderr, marks) {
  const lines = stderr.split('\n')
  const values = Object.values(marks)
  const kept = []
  for (const line of lines) {
    if (values.includes(line)) {
      if (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** Compact stderr for a reported error, keeping a leading policy line. */
function errorDetail(stderr, marks) {
  const lines = stripMarks(stderr, marks).trim().split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return ''
  const policy = lines.find(line => /^(Sorry\b|sudo:|\[sudo\]|bash:)/i.test(line.trim()))
  const tail = lines.slice(-3)
  const chosen = policy !== undefined && !tail.includes(policy) ? [policy, ...tail] : tail
  return chosen.map((line) => line.slice(0, 300)).join('\n')
}

/** Independent random tokens so knowing one marker never reveals another. */
function makeMarks() {
  const token = () => `__REMOTE_SSH_SUDO_${randomUUID()}__`
  return {
    probe: `__REMOTE_SSH_SUDO_PROBE_${randomUUID()}__`,
    probeOk: `__REMOTE_SSH_SUDO_PROBEOK_${randomUUID()}__`,
    auth: token(),
    ticket: token(),
    drain: token(),
    cd: token(),
    start: token(),
    post: token(),
  }
}

/**
 * One SSH invocation of the remote sudo flow.
 * @returns {Promise<{ok: true, code: number|null, stdout: string, stderr: string,
 *   stdoutTruncated?: boolean, stderrTruncated?: boolean}
 *   | {ok: false, error: string, authRequired?: boolean, timedOut?: boolean,
 *      code?: number|null, stdout?: string, stderr?: string}>}
 */
async function executeSudo(target, { command, workdir, mode, password, timeoutMs, signal }) {
  const marks = makeMarks()
  // The caller's copy is no longer needed once the bytes for sudo are queued;
  // sshRun wipes the wire copy when its stdin finishes.
  const input = mode === 'password' ? Buffer.concat([password, Buffer.from('\n')]) : undefined
  if (mode === 'password') password.fill(0)
  let result
  try {
    result = await sshRun({
      target: target.ssh,
      port: target.port,
      controlPersist: target.controlPersist,
      command: remoteSudoScript({ command, workdir, mode, marks }),
      stdin: input,
      wipeStdin: true,
      signal,
      timeoutMs,
      maxStdout: 512 * 1024,
      maxStderr: 64 * 1024,
    })
  } catch (error) {
    // sshRun clears the cache itself on a genuine ssh-255 host-key failure;
    // text matching here would also catch a remote exit code that mentions it.
    return { ok: false, error: error?.message ?? String(error) }
  } finally {
    input?.fill(0)
  }

  if (result.timedOut) {
    return {
      ok: false,
      timedOut: true,
      code: null,
      stdout: result.stdout,
      stderr: stripMarks(result.stderr, marks),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      error: `sudo command did not finish within ${timeoutMs}ms`,
    }
  }
  const detail = errorDetail(result.stderr, marks)
  // The START/authentication markers are printed before the command; keep
  // scanning a bounded head of stderr so a command that floods stderr (and
  // then exits before POST) is still recognized as having run.
  const seen = `${result.stderrHead ?? ''}\n${result.stderr ?? ''}`
  // Markers are printed as standalone lines. Substring matching would also
  // match sudo's denial message, which echoes the wrapper command line
  // containing the marker tokens without ever running the command.
  const seenLines = new Set(seen.split('\n').map((line) => line.trim()))
  const saw = (mark) => seenLines.has(mark)
  // START/POST are authoritative: once the command was reached, marker-looking
  // text it printed itself (for example its own /proc/$$/cmdline, which
  // contains the cd/start/post tokens) must not turn a completed run into a
  // false cd/auth/ticket failure.
  const ran = saw(marks.start) || saw(marks.post)
  if (mode !== 'probe' && ran) {
    return {
      ok: true,
      code: result.code,
      stdout: result.stdout,
      stderr: stripMarks(result.stderr, marks),
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    }
  }
  if (saw(marks.drain)) {
    return { ok: false, error: 'the sudo password could not be drained safely before the command; no command was run' }
  }
  if (saw(marks.ticket)) {
    return {
      ok: false,
      error: `sudo on "${target.name}" authenticated but did not keep a credential ticket; the remote sudoers needs a nonzero timestamp_timeout (or NOPASSWD) for this tool`,
    }
  }
  if (saw(marks.cd)) {
    return { ok: false, error: `cannot change to remote working directory ${workdir}` }
  }
  if (mode === 'probe') {
    if (result.code === 0 && saw(marks.probeOk)) {
      return {
        ok: true,
        code: 0,
        stdout: result.stdout,
        stderr: stripMarks(result.stderr, marks),
      }
    }
    if (!saw(marks.probe)) {
      return { ok: false, error: `the sudo probe did not complete (exit ${result.code ?? 'unknown'})${detail ? `: ${detail}` : ''}` }
    }
  }
  const failed = (mode === 'probe' && saw(marks.probe))
    || (mode === 'password' && saw(marks.auth))
  if (failed) {
    if (SETUP_RE.test(detail)) {
      return { ok: false, error: `sudo is not available on the remote host: ${detail || 'command not found'}` }
    }
    if (POLICY_RE.test(detail)) {
      return { ok: false, error: `sudo is not permitted on "${target.name}": ${detail}` }
    }
    return {
      ok: false,
      authRequired: true,
      code: result.code,
      stdout: result.stdout,
      stderr: detail,
    }
  }
  if (mode !== 'probe') {
    // No START/POST: sudo failed before the command started, so report an
    // error instead of a misleading command exit. Never fall back to a
    // password here, which could run an already-executed command twice.
    return { ok: false, error: `sudo did not run the command${detail ? `: ${detail}` : ''}` }
  }
  return {
    ok: true,
    code: result.code,
    stdout: result.stdout,
    stderr: stripMarks(result.stderr, marks),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}

/**
 * Run `command` as root on `target`.
 *
 * @param {object} target remote target (needs ssh, port, name)
 * @param {object} options
 * @param {string} options.command    command to run under sudo
 * @param {string} options.workdir    remote absolute working directory
 * @param {number} [options.timeoutMs] total result-wait budget, default 300s;
 *   covers the probes, any password entry and the command, but excludes prior
 *   SSH connection preparation
 * @param {number} [options.promptTimeoutMs] password-entry budget, default
 *   150s; capped by the remaining `timeoutMs`. Cancellation does not guarantee
 *   that a terminal still reading input closes.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: true, code: number|null, stdout: string, stderr: string}
 *   | {ok: false, error: string, timedOut?: boolean, code?: number|null, stdout?: string, stderr?: string}>}
 */
export async function runSudoCommand(target, {
  command,
  workdir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
  signal,
}) {
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(0, deadline - Date.now())
  const timedOut = () => ({ ok: false, timedOut: true, error: `sudo command did not finish within ${timeoutMs}ms` })

  // 1. Authentication-only probe: it executes no user code, so its result
  // cannot be forged into a second execution.
  const probe = await executeSudo(target, {
    mode: 'probe',
    timeoutMs: Math.max(1, remaining()),
    signal,
  })
  if (probe.ok) {
    if (signal?.aborted) return { ok: false, error: 'aborted' }
    const budget = remaining()
    if (budget <= 0) return timedOut()
    // NOPASSWD or a global ticket: run the command with no password at all.
    return executeSudo(target, {
      command,
      workdir,
      mode: 'command',
      timeoutMs: budget,
      signal,
    })
  }
  if (!probe.authRequired) return probe
  if (signal?.aborted) return { ok: false, error: 'aborted' }

  // 2. Cached password (entered within the TTL) or a fresh terminal prompt.
  // Validate the TTL only now, so a passwordless call never fails on it. The
  // resolved ssh identity prevents reusing a credential after ~/.ssh/config
  // changes HostName/User/Port under the same alias; it is bounded by the
  // call budget and skipped entirely when caching is disabled.
  const ttlMs = sudoCacheTtlMs()
  let identity
  if (ttlMs > 0) {
    const identityBudget = remaining()
    if (identityBudget <= 0) return timedOut()
    identity = await resolveSshIdentity(target, { timeoutMs: Math.min(5000, identityBudget) })
  }
  const promptBudget = Math.min(promptTimeoutMs, remaining())
  if (promptBudget <= 0) return timedOut()
  const acquired = await obtainPassword(target, { ttlMs, promptTimeoutMs: promptBudget, identity, signal })
  if (!acquired.ok) return acquired

  let result
  try {
    const budget = remaining()
    if (budget <= 0) return timedOut()
    result = await executeSudo(target, {
      command,
      workdir,
      mode: 'password',
      password: acquired.password,
      timeoutMs: budget,
      signal,
    })
  } finally {
    acquired.password.fill(0)
  }

  if (result.authRequired) {
    // The password was rejected. Drop exactly the entry this call used (never
    // a newer one a concurrent prompt just stored), without invalidating an
    // open prompt, and do NOT retry: user code must never run twice in a call.
    // A no-cache prompt has no token and must not drop unrelated slots.
    if (acquired.token !== undefined) dropCachedSudoPassword(sudoCacheKey(target), acquired.token)
    const detail = result.stderr ?? ''
    return {
      ok: false,
      code: result.code ?? null,
      stdout: result.stdout ?? '',
      stderr: detail,
      error: `sudo authentication failed on "${target.name}"${detail ? `: ${detail}` : ''}`,
    }
  }
  return result
}
