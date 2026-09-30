import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { sshExec, sshRun, shq } from '../ssh.js'
import { resolveRemote } from '../target.js'
import { checkArgs, defTextTool } from '../toolkit.js'

const JOB_SCRIPT = readFileSync(new URL('../jobs.py', import.meta.url), 'utf8')

export async function remoteJob(target, request, signal) {
  const output = await sshExec({
    target: target.ssh, port: target.port, controlPersist: target.controlPersist,
    command: `python3 -c ${shq(JOB_SCRIPT)}`,
    stdin: JSON.stringify(request), signal, timeoutMs: 30_000,
  })
  return JSON.parse(output.toString('utf8'))
}

export function makeBashTool(target, cwd = target.root) {
  return defTextTool({
    name: 'bash',
    description: 'Execute bash on the selected remote host. Each call starts a fresh shell. Commands have the SSH account permissions. Background jobs return a job_id; use job_output/job_kill with the same target. Remote Linux requires bash and python3.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: 'Bash command to run on the remote host.' },
        description: { type: 'string', description: 'Short description of the command.' },
        workdir: { type: 'string', description: 'Remote working directory; relative to target root by default.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600000, description: 'Foreground timeout in milliseconds; default 120000, cap 600000. The remote process may survive a timeout.' },
        run_in_background: { type: 'boolean', description: 'Start a persistent remote job with no command timeout.' },
      },
      required: ['command'],
    },
    async execute(args, exec) {
      const a = checkArgs('bash', args, { command: 'string', description: '?string', workdir: '?string', timeoutMs: '?integer', run_in_background: '?boolean' })
      const dir = resolveRemote(a.workdir ?? '.', cwd)
      if (a.run_in_background) {
        const job_id = randomUUID()
        try {
          return JSON.stringify(await remoteJob(target, { action: 'start', job_id, workdir: dir, command: a.command }, exec.signal))
        } catch (error) {
          throw new Error(`Background launch may have started job ${job_id}; use job_output with this ID to check. ${error.message}`)
        }
      }
      const result = await sshRun({
        target: target.ssh, port: target.port, controlPersist: target.controlPersist,
        command: `cd ${shq(dir)} && bash -c ${shq(a.command)}`, signal: exec.signal,
        timeoutMs: a.timeoutMs ?? 120000, maxStdout: 512 * 1024,
      })
      let output = result.stdout
      if (result.stderr) output += `\n[stderr]\n${result.stderr}`
      if (result.timedOut) output += '\n[command timed out; the remote process may still be running]'
      return `${output}\n[exit code: ${result.code ?? 'unknown'}]`
    },
  })
}
