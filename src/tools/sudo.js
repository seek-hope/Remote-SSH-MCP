/**
 * sudo.js — the `sudo` tool: run one command as root on a remote target.
 *
 * Each call first tries a non-interactive sudo; only a real authentication
 * challenge opens a terminal. The password is then cached in memory for a
 * short window so later calls do not ask again. See src/sudo.js and
 * src/sudocache.js.
 */

import { runSudoCommand } from '../sudo.js'
import { resolveRemote } from '../target.js'
import { checkArgs, defTextTool } from '../toolkit.js'
import { hasBinaryContent } from './files.js'

export function makeSudoTool(target, cwd = target.root) {
  return defTextTool({
    name: 'sudo',
    description: 'Run a command as root on the selected remote host via sudo. Each call first runs an authentication-only `sudo -n -v` (no user command). If it succeeds (NOPASSWD or a valid global sudo ticket), the command runs with `sudo -n` in a second SSH call. Otherwise the sudo password comes from an in-memory cache for this SSH destination and its resolved host/user/port (entered in a terminal within the last 20 minutes by default), or a terminal on the machine running this service asks for it; the password is sent only to `sudo -S -v`, the ticket is re-checked, any unconsumed password line is drained, and the command runs with `sudo -n`. Authentication never executes user code, so a command cannot cause a second execution, and a rejected password is not retried in the same call. The password is never returned, logged or written to disk; REMOTE_SSH_SUDO_CACHE_MS=0 disables the cache, and removing, disconnecting, or changing a target\'s ssh/port clears it in this MCP process. The remote sudoers must retain a credential ticket (nonzero `timestamp_timeout`) or grant NOPASSWD covering both `sudo -n -v` and the wrapper `bash` (typically `NOPASSWD: ALL`); `timestamp_timeout=0` is unsupported otherwise. Foreground only; timeout or cancellation only terminates the local SSH process and the remote command may continue. Check remote state before retrying.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: 'Command to run as root on the remote host.' },
        workdir: { type: 'string', description: 'Remote working directory; relative to the target root by default.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, description: 'Total result-wait timeout in milliseconds; default 300000, cap 600000. Covers the authentication probe, any sudo password entry (at most 150000, limited by the remaining budget) and the command; excludes prior SSH connection preparation, while the terminal launch for a password prompt is inside the password-entry budget. Cancellation may leave the prompt open and the remote command running.' },
      },
      required: ['command'],
    },
    async execute(args, exec) {
      const a = checkArgs('sudo', args, { command: 'string', workdir: '?string', timeoutMs: '?integer' })
      if (hasBinaryContent(a.command)) throw new Error('sudo: command must be UTF-8 text without NUL bytes or unpaired surrogates')
      if (hasBinaryContent(a.workdir ?? '')) throw new Error('sudo: workdir must be UTF-8 text without NUL bytes or unpaired surrogates')
      const dir = resolveRemote(a.workdir ?? '.', cwd)
      const result = await runSudoCommand(target, {
        command: a.command,
        workdir: dir,
        timeoutMs: a.timeoutMs ?? 300_000,
        signal: exec.signal,
      })
      if (!result.ok && !result.timedOut) {
        throw new Error(/^sudo\b/.test(result.error) ? result.error : `sudo: ${result.error}`)
      }
      let output = result.stdout ?? ''
      if (result.stdoutTruncated) output = '[stdout truncated; showing the tail]\n' + output
      if (result.stderr) output += `\n[stderr${result.stderrTruncated ? ' truncated; showing the tail' : ''}]\n${result.stderr}`
      if (result.timedOut) output += '\n[command timed out; the remote command may still be running]'
      return `${output}\n[exit code: ${result.code ?? 'unknown'}]`
    },
  })
}
