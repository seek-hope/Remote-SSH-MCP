/**
 * ssh.js — process-per-call SSH execution layer (pi-style).
 *
 * Every operation spawns one `ssh` process — no ssh2 dependency, no sftp.
 * Connection reuse is delegated to OpenSSH ControlMaster/ControlPersist:
 * ordinary calls use `auto` (reuse a master when one exists); the `connect`
 * action warms one up interactively in a temporary terminal. Plain key/agent
 * calls still use BatchMode.
 */

import { spawn, execFile } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { effectiveControlPersist } from './target.js'
import { withStoreLock } from './store.js'

const execFileAsync = promisify(execFile)

/** ControlMaster socket directory (0700 — OpenSSH rejects a shared dir). */
const controlDir = () => resolve(process.env.REMOTE_SSH_CONTROL_DIR || join(homedir(), '.cache', 'remote-ssh', 'control'))

/** In-flight ControlMaster warm-ups, one per ssh destination. */
const masterWarmers = new Map()

/** Recent interactive warm-up failures, used to avoid popping terminal after terminal. */
const recentWarmFailures = new Map()
const WARM_FAILURE_RETRY_MS = 30_000

// Keep host/key/proxy settings, but do not inherit interactive login commands
// or rebind forwarded ports on every MCP call. Older clients lack the newer
// session options (and cannot have those options in their config either).
const SESSION_ARGS = [
  '-o', 'IgnoreUnknown=RemoteCommand,SessionType,StdinNull,ForkAfterAuthentication',
  '-o', 'RemoteCommand=none', '-o', 'ClearAllForwardings=yes',
]

/** Create the ControlPath directory once per process (and keep it private). */
async function ensureControlDir() {
  await mkdir(controlDir(), { recursive: true, mode: 0o700 })
  await chmod(controlDir(), 0o700)
}

/** [-p port] for targets that override the port. */
function portArgs(target) {
  return target.port !== undefined ? ['-p', String(target.port)] : []
}

/**
 * ControlMaster/ControlPersist args for ordinary tool calls. `auto` reuses an
 * existing master when present and otherwise falls back to a plain connection
 * (which still fails fast under BatchMode when the key needs a passphrase).
 * opts.controlPersist is the per-target seconds value (undefined = default).
 */
function controlArgs(opts) {
  if (process.platform === 'win32') return [] // ControlMaster sockets are not wired up on Windows here
  const seconds = effectiveControlPersist(opts)
  if (seconds <= 0) return ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlDir()}/%C`,
    '-o', `ControlPersist=${seconds}`,
  ]
}

/** Tool processes never prompt; authentication happens only in a terminal. */
async function sshSpawn(opts, command) {
  const { target, port, controlPersist } = opts
  if (typeof target !== 'string' || !target || target.startsWith('-') || /[\s\0]/.test(target)) {
    throw new Error(`sshSpawn: target must be a non-empty ssh destination string (received ${typeof target})`)
  }
  const ctl = controlArgs({ controlPersist })
  if (effectiveControlPersist({ controlPersist }) > 0) await ensureControlDir()
  const portOptionArgs = portArgs({ port })
  // A single ASCII argument also survives csh/tcsh newline/history quoting.
  // Decode inside POSIX sh without consuming the command's stdin payload.
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  const script = `remote_ssh_script=$(printf %s ${encoded} | base64 -d) && eval "$remote_ssh_script"`
  return {
    command: 'ssh',
    // `--` ends option parsing so a destination can never be read as an option.
    args: ['-T', ...SESSION_ARGS,
      '-o', 'SessionType=default', '-o', 'StdinNull=no', '-o', 'ForkAfterAuthentication=no',
      '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
      ...ctl, ...portOptionArgs, '--', target, `sh -c ${shq(script)}`],
  }
}

/** Quote one string for POSIX shell single-quote context. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Append `chunk` to `chunks`, dropping bytes from the head so the buffered
 * total stays <= `cap`. Returns the new total. Used to bound memory while
 * keeping the tail of a stream.
 * @param {Buffer[]} chunks
 * @param {number} byteCount current total
 * @param {Buffer} chunk
 * @param {number} cap
 * @returns {number}
 */
export function keepTail(chunks, byteCount, chunk, cap) {
  chunks.push(chunk)
  let total = byteCount + chunk.length
  while (total > cap && chunks.length > 0) {
    const head = chunks[0]
    const excess = total - cap
    if (head.length <= excess) {
      chunks.shift()
      total -= head.length
    } else {
      chunks[0] = head.subarray(excess)
      total = cap
    }
  }
  return total
}

/**
 * Spawn one ssh child and collect its streams with tail-keeping; the transport
 * mechanics shared by sshExec and sshRun. A race between abort, timeout, spawn
 * error and close settles exactly once.
 *
 * - `onTimeout` (optional): return the Error to reject with. When omitted, a
 *   timeout only kills the child and lets `close` resolve (sshRun reads
 *   `timedOut` itself).
 * - `onClose` receives the collected streams and a `settle` handle
 *   (`resolve`/`reject`) so each caller maps the transport result its own way.
 */
function runSshChild(spec, { stdin, signal, timeoutMs, maxStdout, maxStderr, onTimeout, onClose }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const outChunks = []
    const errChunks = []
    let outBytes = 0
    let errBytes = 0
    let outTotal = 0
    let timedOut = false
    let settled = false
    const kill = () => { try { child.kill('SIGKILL') } catch {} }
    const finish = (fn, val) => {
      if (settled) return
      settled = true
      cleanup()
      fn(val)
    }
    const onAbort = () => { kill(); finish(reject, new Error('aborted')) }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          kill()
          if (onTimeout) finish(reject, onTimeout())
        }, timeoutMs)
      : undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // keepTail bounds memory on both streams and keeps the TAIL, so the error
    // message (last stderr lines) and any truncation/exit marker stay accurate.
    child.stdout.on('data', (d) => {
      outTotal += d.length
      outBytes = keepTail(outChunks, outBytes, d, maxStdout)
    })
    child.stderr.on('data', (d) => { errBytes = keepTail(errChunks, errBytes, d, maxStderr) })
    child.on('error', (e) => finish(reject, new Error(`ssh spawn failed: ${e.message}`)))
    child.on('close', (transportCode) => {
      onClose({
        transportCode, timedOut, outChunks, errChunks, outTotal, outBytes, errBytes,
        settle: { resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e) },
      })
    })
    if (stdin !== undefined) {
      child.stdin.on('error', () => {}) // remote closed early; close event reports it
      child.stdin.end(stdin)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Run a remote command via ssh. Resolves with stdout (Buffer).
 * Rejects on non-zero exit (message carries stderr tail), spawn failure,
 * abort, or local timeout (the local ssh client is killed; the remote
 * process is best-effort reaped by the server's SIGHUP handling).
 *
 * @param {object} opts
 * @param {string} opts.target      ssh destination (alias or user@host)
 * @param {string} opts.command     remote command line (run via the remote login shell)
 * @param {Buffer|string} [opts.stdin]  bytes piped to the remote command's stdin
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs] local watchdog, default 120s; 0 = no timeout
 * @param {number} [opts.maxStdout] cap collected stdout bytes (tail kept), default 8 MiB
 * @param {number} [opts.maxStderr] cap collected stderr bytes (tail kept), default 64 KiB
 * @param {number} [opts.controlPersist] per-target ControlPersist seconds
 *   (undefined = default on; 0 disables ControlMaster reuse)
 * @returns {Promise<Buffer>}
 */
export async function sshExec(opts) {
  const {
    command,
    stdin,
    signal,
    timeoutMs = 120_000,
    maxStdout = 8 * 1024 * 1024,
    maxStderr = 64 * 1024,
  } = opts
  const spec = await sshSpawn(opts, command)
  return runSshChild(spec, {
    stdin, signal, timeoutMs, maxStdout, maxStderr,
    onTimeout: () => new Error(`ssh timeout after ${timeoutMs}ms: ${command.slice(0, 120)}`),
    onClose: ({ transportCode, outChunks, errChunks, outTotal, settle }) => {
      const stderr = Buffer.concat(errChunks).toString('utf8')
      if (transportCode !== 0) {
        const tail = stderr.trim().split('\n').slice(-5).join('\n')
        return settle.reject(new Error(`remote command failed (exit ${transportCode}): ${tail || '(no stderr)'}`))
      }
      const out = Buffer.concat(outChunks)
      if (outTotal > maxStdout) {
        return settle.resolve(Buffer.concat([Buffer.from(`[output truncated to last ${maxStdout} bytes]\n`), out]))
      }
      settle.resolve(out)
    },
  })
}

/**
 * Like sshExec, but never rejects on the remote exit code: resolves with
 * { code, stdout, stderr } so callers (bash) can report non-zero exits as
 * data. Still rejects on spawn failure, abort, timeout, or missing marker.
 *
 * The remote command is wrapped so the remote exit code rides along as the
 * final stdout line, making the ssh transport exit code always 0 for a
 * completed remote run.
 *
 * @param {object} opts same as sshExec, plus
 * @param {number} [opts.maxStderr] cap collected stderr bytes (tail kept), default 64 KiB
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut?: boolean }>}
 */
export async function sshRun(opts) {
  const { command, stdin, signal, timeoutMs = 120_000, maxStdout = 4 * 1024 * 1024, maxStderr = 64 * 1024 } = opts
  const MARK = `__REMOTE_SSH_EXIT_${randomUUID()}__`
  // Subshell, not brace group: an `exit` inside the command must not kill the
  // wrapper before the marker is printed. The marker is random per call, so
  // command output can never spoof the transport's exit-code line.
  const wrapped = `( ${command}\n); __rc=$?; echo "${MARK}\${__rc}"`
  const spec = await sshSpawn(opts, wrapped)
  // No onTimeout: a local timeout only kills the child and lets `close`
  // resolve with timedOut:true (sshRun reports timeouts as data).
  return runSshChild(spec, {
    stdin, signal, timeoutMs, maxStdout, maxStderr,
    onClose: ({ transportCode, timedOut, outChunks, errChunks, settle }) => {
      let stdout = Buffer.concat(outChunks).toString('utf8')
      const stderr = Buffer.concat(errChunks).toString('utf8')
      if (timedOut) {
        return settle.resolve({ code: null, stdout, stderr, timedOut: true })
      }
      if (transportCode !== 0) {
        return settle.reject(new Error(`ssh transport failed (exit ${transportCode}): ${stderr.trim().split('\n').slice(-3).join('\n')}`))
      }
      const idx = stdout.lastIndexOf(MARK)
      if (idx === -1) {
        return settle.reject(new Error(`remote run ended without exit marker: ${stdout.slice(-200)}`))
      }
      const code = parseInt(stdout.slice(idx + MARK.length).trim(), 10)
      stdout = stdout.slice(0, idx).replace(/\n$/, '')
      settle.resolve({ code: Number.isFinite(code) ? code : null, stdout, stderr })
    },
  })
}

/**
 * Run `ssh -O <op>` against a target's ControlPath (op: check|exit).
 * Resolves with { code, stdout, stderr }; never throws.
 */
export async function sshControl(target, op, timeoutMs = 15_000) {
  if (op !== 'check' && op !== 'exit') throw new Error(`sshControl: unsupported operation "${op}"`)
  if (process.platform === 'win32') {
    return { code: 255, stdout: '', stderr: 'ControlMaster control operations are not supported on Windows' }
  }
  if (effectiveControlPersist(target) <= 0) {
    return { code: 255, stdout: '', stderr: `ControlPersist is disabled for "${target.name}"` }
  }
  await ensureControlDir()
  // -O operations only address an existing socket: ControlMaster is not used.
  // `--` ends option parsing before the destination.
  const args = ['-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', '-o', `ControlPath=${controlDir()}/%C`, ...portArgs(target), '-O', op, '--', target.ssh]
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err })
    }
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      done(null)
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => { err += `ssh spawn failed: ${e.message}`; done(null) })
    child.on('close', (code) => done(code))
  })
}

/** Stable key for one ssh destination's master; all roots on a host share it. */
function masterKey(target) {
  return `${controlDir()}\u0000${target.ssh}\u0000${target.port ?? ''}`
}

async function warmControlMaster(target, options) {
  // Let OpenSSH resolve aliases, users, ports and ProxyJump exactly as it does
  // for a real command. All MCP processes sharing this socket share its lock.
  const spec = await sshSpawn({ target: target.ssh, port: target.port, controlPersist: target.controlPersist }, 'true')
  const { stdout } = await execFileAsync(spec.command, ['-G', ...spec.args], { timeout: 10_000, maxBuffer: 512 * 1024 })
  const socket = stdout.match(/^controlpath (.+)$/m)?.[1].trim()
  if (!socket || socket === 'none') throw new Error('OpenSSH did not resolve a reusable ControlPath')
  return withStoreLock(socket, async () => {
    const existing = await sshControl(target, 'check', 10_000)
    if (existing.code === 0) return { ok: true, mode: 'reused', detail: (existing.stderr || existing.stdout).trim() }
    return establishControlMaster(target, options)
  }, { timeoutMs: 200_000 }) // Covers the headless probe plus terminal authentication.
}

/**
 * Ensure a ControlMaster exists for `target` before any remote command runs.
 *
 * Order of operations:
 *  1. reuse an already-running master;
 *  2. try one headless `ssh ... true` probe (BatchMode/agent) — on success the `ControlMaster=auto` transport leaves
 *     a master behind via ControlPersist;
 *  3. when `interactive` is true, open the temporary terminal so the user can
 *     type the key passphrase, then poll until the master appears.
 *
 * Concurrent callers share one in-flight warm-up per destination. The shared
 * warm-up runs on its OWN lifecycle: a caller's abort detaches only that
 * caller (the warm-up is never killed out from under the others), and when a
 * caller that may open a terminal finds a headless-only warm-up in flight,
 * it waits for it and starts an interactive warm-up of its own if the
 * headless one failed ("any caller needing interactivity gets interactivity").
 * A recent failed terminal attempt is replayed for 30s instead of opening
 * another terminal; a later `ssh -O check` success always wins and clears it.
 *
 * @param {object} target remote target
 * @param {object} [options]
 * @param {boolean} [options.interactive] open a terminal when headless auth fails (default true)
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ ok: true, mode: 'reused'|'started'|'terminal'|'disabled', detail?: string }
 *         | { ok: false, mode: 'headless'|'terminal-unavailable'|'timeout'|'aborted'|'unexpected', error: string, detail?: string }>}
 */
export async function ensureControlMaster(target, options = {}) {
  const interactive = options.interactive !== false
  const signal = options.signal
  if (signal?.aborted) return { ok: false, mode: 'aborted', error: 'aborted' }

  if (effectiveControlPersist(target) <= 0) return { ok: true, mode: 'disabled', detail: 'ControlPersist is disabled' }

  // A master from any source (previous session, manual connect) is the answer.
  let existing
  try {
    existing = await sshControl(target, 'check', 10_000)
  } catch (error) {
    return { ok: false, mode: 'unexpected', error: String(error?.message ?? error) }
  }
  if (signal?.aborted) return { ok: false, mode: 'aborted', error: 'aborted' }
  if (existing.code === 0) {
    recentWarmFailures.delete(masterKey(target))
    return { ok: true, mode: 'reused', detail: existing.stdout.trim() }
  }

  const key = masterKey(target)
  for (;;) {
    const inFlight = masterWarmers.get(key)
    if (inFlight !== undefined) {
      const result = await waitForWarm(inFlight.promise, signal)
      if (result.mode === 'aborted' || inFlight.interactive || !interactive || result.ok) return result
      // A headless-only warm-up failed, but THIS caller may open a terminal:
      // drop the spent entry and loop to start an interactive warm-up.
      if (masterWarmers.get(key) === inFlight) masterWarmers.delete(key)
      continue
    }

    const recent = recentWarmFailures.get(key)
    if (recent !== undefined && Date.now() - recent.at < WARM_FAILURE_RETRY_MS) return recent.result

    // establishControlMaster deliberately receives NO caller signal: the
    // shared warm-up must not be killed by one caller's abort.
    const warm = { interactive, promise: undefined }
    warm.promise = warmControlMaster(target, { interactive })
      .catch((error) => ({
        ok: false,
        mode: 'unexpected',
        error: String(error?.message ?? error),
      }))
      .then((result) => {
        // Only a failed TERMINAL attempt is worth replaying: it avoids a burst
        // of windows for the same bad credentials. A headless/transient failure
        // never opened a window, so it must not suppress a timely retry.
        if (!result.ok && interactive && (result.mode === 'timeout' || result.mode === 'terminal-unavailable')) {
          recentWarmFailures.set(key, { at: Date.now(), result })
        }
        return result
      })
      .finally(() => {
        // The task owns its registration until it settles, even if its first
        // caller has already detached. Later callers must still join it.
        if (masterWarmers.get(key) === warm) masterWarmers.delete(key)
      })
    masterWarmers.set(key, warm)
    return waitForWarm(warm.promise, signal)
  }
}

/**
 * Await a shared warm-up promise. A caller's abort detaches only that caller
 * (resolving to the 'aborted' result); the warm-up itself keeps running for
 * the other callers.
 */
function waitForWarm(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve({ ok: false, mode: 'aborted', error: 'aborted' })
  return new Promise((resolve) => {
    const onAbort = () => resolve({ ok: false, mode: 'aborted', error: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((result) => {
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    })
  })
}

async function establishControlMaster(target, { interactive }) {
  const persist = effectiveControlPersist(target)
  if (persist <= 0) return { ok: true, mode: 'disabled' }

  let headlessError = 'unknown ssh error'
  try {
    // `ControlMaster=auto` in sshSpawn creates and keeps a master on success.
    // sshExec's `target` field is the ssh DESTINATION STRING; passing the
    // whole RemoteTarget object here made spawn stringify it to
    // "[object Object]" and OpenSSH fail with
    // "hostname contains invalid characters".
    await sshExec({
      target: target.ssh,
      port: target.port,
      command: 'true',
      controlPersist: persist,
      timeoutMs: 20_000,
    })
    return { ok: true, mode: 'started' }
  } catch (error) {
    headlessError = String(error?.message ?? error)
  }

  // Only an authentication-shaped failure is worth a terminal: popping a
  // window for a dead host or a bad ssh alias would be noise.
  const authHint = /permission denied|publickey|password|passphrase|authentication|no supported authentication|host key verification failed/i
  if (!interactive || !authHint.test(headlessError)) {
    return {
      ok: false,
      mode: 'headless',
      error: `automatic ssh connection failed for "${target.name}": ${headlessError}`,
    }
  }

  const opened = await openConnectTerminal(target)
  if (!opened.ok) {
    return {
      ok: false,
      mode: 'terminal-unavailable',
      error: `cannot open a terminal to authenticate "${target.name}": ${opened.error}`,
      detail: headlessError,
    }
  }

  // Same interactive-auth budget as the manual connect action.
  const waitMs = Math.min(
    150_000,
    Math.max(Number.parseInt(process.env.REMOTE_SSH_CONNECT_TIMEOUT_MS, 10) || 150_000, 1_000),
  )
  const wait = await waitForMaster(target, { timeoutMs: waitMs })
  if (!wait.ok) {
    return {
      ok: false,
      mode: 'timeout',
      error: `temporary terminal opened (${opened.terminal}) but no ControlMaster appeared within ${Math.round(waitMs / 1000)}s. Type the password/passphrase in the terminal window. Last status: ${wait.detail || '(none)'}`,
    }
  }
  return { ok: true, mode: 'terminal', detail: wait.detail }
}

/** Poll `ssh -O check` until a master appears (or the deadline passes). */
export async function waitForMaster(target, { timeoutMs = 70_000, intervalMs = 750, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (signal?.aborted) return { ok: false, detail: 'aborted' }
    const r = await sshControl(target, 'check', 10_000)
    if (r.code === 0) return { ok: true, detail: r.stdout.trim() }
    if (Date.now() >= deadline) return { ok: false, detail: (r.stderr || r.stdout).trim() }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * The command a temporary terminal runs to warm up the master:
 * ssh authenticates interactively in the terminal, then `-f` daemonizes it
 * (so the window closes) and ControlPersist keeps the connection alive.
 */
export function buildConnectCommand(target) {
  const seconds = effectiveControlPersist(target)
  if (seconds <= 0) return undefined
  const args = [
    'ssh', '-T',
    ...SESSION_ARGS,
    '-o', 'ConnectTimeout=20',
    '-o', 'LogLevel=ERROR',
    '-o', 'ControlMaster=yes',
    '-o', `ControlPath=${controlDir()}/%C`,
    '-o', `ControlPersist=${seconds}`,
    '-o', 'BatchMode=no',
    '-o', 'StrictHostKeyChecking=ask',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-f', '-N',
    ...portArgs(target),
    '--',
    target.ssh,
  ]
  return args.map(shq).join(' ')
}

/** Split a REMOTE_SSH_TERMINAL override into argv (quotes supported). */
function splitShellWords(s) {
  const words = []
  let cur = ''
  let quote = null
  for (const ch of s) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === ' ' || ch === '\t') {
      if (cur) { words.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (quote !== null) throw new Error('unterminated quote')
  if (cur) words.push(cur)
  return words
}

/** Resolve once: an unref'd child that has actually spawned. */
function spawnDetached(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } })
    let timer
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.unref()
      if (error) reject(error)
      else resolve(bin)
    }
    child.once('error', finish)
    child.once('exit', (code, signal) => finish(code === 0 ? undefined : new Error(`${bin} exited with ${signal ?? `exit code ${code}`}`)))
    child.once('spawn', () => {
      // ponytail: catch immediate launcher failures; the ControlMaster poll
      // remains the proof of authentication if a GUI fails after this window.
      timer = setTimeout(() => finish(), 250)
    })
  })
}

const LINUX_TERMINALS = [
  { name: 'gnome-terminal', args: (cmd) => ['--window', '--', 'bash', '-lc', cmd] },
  { name: 'konsole', args: (cmd) => ['--separate', '-e', 'bash', '-lc', cmd] },
  { name: 'xfce4-terminal', args: (cmd) => ['--window', '-x', 'bash', '-lc', cmd] },
  { name: 'mate-terminal', args: (cmd) => ['--window', '--', 'bash', '-lc', cmd] },
  { name: 'x-terminal-emulator', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
  { name: 'xterm', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
  { name: 'kitty', args: (cmd) => ['bash', '-lc', cmd] },
  { name: 'alacritty', args: (cmd) => ['-e', 'bash', '-lc', cmd] },
  { name: 'wezterm', args: (cmd) => ['start', '--', 'bash', '-lc', cmd] },
  { name: 'foot', args: (cmd) => ['bash', '-lc', cmd] },
]

/**
 * Open a temporary terminal that runs buildConnectCommand(target) and lets
 * the user answer ssh's password/passphrase prompt interactively.
 * @returns {Promise<{ok: true, terminal: string} | {ok: false, error: string}>}
 */
export async function openConnectTerminal(target) {
  const command = buildConnectCommand(target)
  if (command === undefined) {
    return { ok: false, error: `ControlPersist is disabled for "${target.name}" (set controlPersist > 0 first)` }
  }
  await ensureControlDir()

  const override = process.env.REMOTE_SSH_TERMINAL
  if (override !== undefined && override.trim() !== '') {
    let parts
    try { parts = splitShellWords(override.trim()) } catch (e) {
      return { ok: false, error: `REMOTE_SSH_TERMINAL: ${e.message}` }
    }
    if (parts.length === 0) return { ok: false, error: 'REMOTE_SSH_TERMINAL is empty' }
    try {
      await spawnDetached(parts[0], [...parts.slice(1), command])
      return { ok: true, terminal: parts[0] }
    } catch (e) {
      return { ok: false, error: `REMOTE_SSH_TERMINAL "${parts[0]}" failed to spawn: ${e.code ?? e.message}` }
    }
  }

  if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`
    try {
      await spawnDetached('osascript', ['-e', script])
      return { ok: true, terminal: 'Terminal.app' }
    } catch (e) {
      return { ok: false, error: `osascript failed to spawn: ${e.code ?? e.message}` }
    }
  }

  if (process.platform === 'win32') {
    return {
      ok: false,
      error: 'automatic terminal launch is not implemented for Windows — set REMOTE_SSH_TERMINAL to a command that opens a terminal and appends the ssh command',
    }
  }

  const tried = []
  for (const term of LINUX_TERMINALS) {
    try {
      await spawnDetached(term.name, term.args(command))
      return { ok: true, terminal: term.name }
    } catch (e) {
      tried.push(`${term.name} (${e.code ?? 'missing'})`)
    }
  }
  return {
    ok: false,
    error: `no terminal emulator found (tried ${tried.join(', ')}). Set REMOTE_SSH_TERMINAL, e.g. REMOTE_SSH_TERMINAL='gnome-terminal -- bash -lc'`,
  }
}
