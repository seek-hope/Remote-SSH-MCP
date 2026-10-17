import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { findTarget, manageSchema, manageTargets, readyTarget } from './manage.js'
import { makeReadTool, makeWriteTool, makeEditTool } from './tools/files.js'
import { makeGlobTool, makeGrepTool } from './tools/search.js'
import { makeBashTool, remoteJob } from './tools/bash.js'
import { makeSudoTool } from './tools/sudo.js'

const targetArg = z.string().min(1).describe('Exact target name from remote_ssh_targets list. Always select the intended host explicitly.')
const resultOf = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })

export function createServer({ storeFile = process.env.REMOTE_SSH_TARGETS_FILE || join(homedir(), '.config', 'remote-ssh', 'targets.json') } = {}) {
  storeFile = resolve(storeFile)
  const server = new McpServer({ name: 'remote-ssh', version: '1.0.0' }, {
    instructions: [
      'Use remote_ssh_targets to list or manage hosts. Every workspace/job tool requires an explicit target; there is no current host.',
      'Workspace paths are remote; relative paths use the target root, a working directory, not a sandbox. Each bash call starts a fresh shell. Read files before editing.',
      'SSH authentication may open a terminal on the machine running this service; the user enters SSH passwords/passphrases directly into OpenSSH. Use the sudo tool for commands requiring root: its terminal script reads the sudo password and pipes it over SSH. Never request passwords in chat or put them in commands or tool arguments.',
      'Connection preparation precedes command timeouts; allow extra time for it in the MCP client request timeout. A foreground timeout or cancellation does not guarantee that the remote command stopped. Check remote state before retrying commands with side effects.',
      'For long commands use bash run_in_background, then job_output/job_kill with the same target and job_id. If launch fails with a job_id, query that ID before launching again. Jobs and logs survive MCP restarts.',
      'Paginate job_output with next_offset. has_more:false is not proof of completion; check status and exit_code. Only clean up finished jobs after consuming the needed output; cleanup:true permanently deletes the job record and logs.',
    ].join('\n'),
  })
  // ponytail: SDK 2.0.0's _oncancel drops falsy requestId, so cancelling the
  // connection's first request (id 0) never aborts the handler. Abort it here;
  // remove once the SDK treats 0 as a valid id.
  const protocol = server.server
  const oncancel = protocol._oncancel.bind(protocol)
  protocol._oncancel = async (notification) => {
    if (notification.params?.requestId === 0) {
      protocol._requestHandlerAbortControllers.get(0)?.abort(notification.params.reason)
      return
    }
    return oncancel(notification)
  }
  const register = (name, description, inputSchema, execute, readOnly = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
    }, async (args, context) => {
      try {
        return resultOf(await execute(args, context.mcpReq.signal))
      } catch (error) {
        return { ...resultOf(error.message ?? String(error)), isError: true }
      }
    })
  }
  register('remote_ssh_targets', 'List/add/update/remove SSH targets or connect/disconnect/check a ControlMaster. add/update verify the remote root and may open a terminal for authentication. Changes apply to the next call. remove deletes only the target configuration, not remote files or jobs. disconnect closes a shared ControlMaster and may interrupt other calls using it. No passwords are accepted or stored.', manageSchema,
    (args, signal) => manageTargets(args, storeFile, signal))

  for (const make of [makeReadTool, makeWriteTool, makeEditTool, makeGlobTool, makeGrepTool, makeBashTool, makeSudoTool]) {
    // The tool schema is registered once for the whole server, so build it from
    // a target-less stub; each call rebuilds the tool with its routed target.
    const def = make({})
    const parameters = { ...def.parameters, additionalProperties: false, properties: { ...def.parameters.properties, target: z.toJSONSchema(targetArg) }, required: ['target', ...def.parameters.required] }
    // Existing tool schemas describe integers as numbers. Validate them before connecting.
    for (const key of ['offset', 'limit']) if (parameters.properties[key]) parameters.properties[key] = { ...parameters.properties[key], type: 'integer', minimum: 1 }
    const schema = z.fromJSONSchema(parameters)
    register(def.name, def.description, schema, async ({ target: name, ...args }, signal) => {
      const target = await findTarget(storeFile, name)
      await readyTarget(target, signal)
      return make(target).execute(args, { signal })
    }, ['read', 'glob', 'grep'].includes(def.name))
  }

  const jobFields = { target: targetArg, job_id: z.uuid().describe('Job ID returned by background bash or its launch error. Use the same remote host/account that started the job.') }
  register('job_output', 'Read remote job status and merged stdout/stderr. Reuse next_offset for byte pagination. has_more:false means no more output currently, not that the job ended. completed does not mean success: check exit_code. IDs survive MCP restarts. The SSH request timeout is 120 seconds, excluding connection preparation; it does not limit job runtime.', z.strictObject({
    ...jobFields,
    offset: z.number().int().nonnegative().optional().describe('0-based byte offset, not a line number. Default 0; pass next_offset from the previous result to continue.'),
    limit: z.number().int().min(1).max(65536).optional().describe('Maximum output bytes to read; default and maximum 65536.'),
    cleanup: z.boolean().optional().describe('Default false. Permanently delete the job record and logs after this read. Requires a finished job and no more output after this chunk; consume needed earlier chunks first.'),
  }), async ({ target: name, ...args }, signal) => {
    const target = await findTarget(storeFile, name)
    await readyTarget(target, signal)
    return remoteJob(target, { action: 'output', ...args }, signal)
  })
  register('job_kill', 'Terminate a remote background job process group. The remote worker escalates TERM to SIGKILL after a 3-second grace period, so termination continues even if this request is interrupted. It reaps same-group descendants that ignore TERM; detached sessions or daemons may still escape. killed means the signal was accepted, not that every process is gone. Output remains available through job_output. The SSH request timeout is 120 seconds, excluding connection preparation; query job_output to check state after a request failure.', z.strictObject(jobFields), async ({ target: name, ...args }, signal) => {
    const target = await findTarget(storeFile, name)
    await readyTarget(target, signal)
    return remoteJob(target, { action: 'kill', ...args }, signal)
  })
  return server
}
