/**
 * sudo.js — the `sudo` tool: run one command as root on a remote target.
 *
 * The sudo password is entered by the user in a new terminal; see src/sudo.js.
 */

import { runSudoCommand } from '../sudo.js'
import { resolveRemote } from '../target.js'
import { checkArgs, defTextTool } from '../toolkit.js'

export function makeSudoTool(target, cwd = target.root) {
  return defTextTool({
    name: 'sudo',
    description: 'Run a command as root on the selected remote host via sudo. A new terminal on the machine running this service asks the user for the sudo password; the password is piped to sudo over SSH and never reaches the model or this service. Foreground only; the remote host must permit `sudo -S` without a tty (the sudoers `requiretty` default must be off).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: 'Command to run as root on the remote host.' },
        workdir: { type: 'string', description: 'Remote working directory; relative to the target root by default.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, description: 'Overall timeout in milliseconds; default 300000, cap 600000. Includes the time the user needs to authenticate.' },
      },
      required: ['command'],
    },
    async execute(args, exec) {
      const a = checkArgs('sudo', args, { command: 'string', workdir: '?string', timeoutMs: '?integer' })
      const dir = resolveRemote(a.workdir ?? '.', cwd)
      const result = await runSudoCommand(target, {
        command: a.command,
        workdir: dir,
        timeoutMs: a.timeoutMs ?? 300_000,
        signal: exec.signal,
      })
      if (!result.ok && !result.timedOut) throw new Error(`sudo: ${result.error}`)
      let output = result.stdout ?? ''
      if (result.stderr) output += `\n[stderr]\n${result.stderr}`
      if (result.timedOut) output += `\n[command timed out; the remote command may still be running]`
      return `${output}\n[exit code: ${result.code ?? 'unknown'}]`
    },
  })
}
