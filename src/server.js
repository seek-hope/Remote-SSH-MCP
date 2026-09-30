import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { findTarget, manageSchema, manageTargets, readyTarget } from './manage.js'
import { makeReadTool, makeWriteTool, makeEditTool } from './tools/files.js'
import { makeGlobTool, makeGrepTool } from './tools/search.js'
import { makeBashTool, remoteJob } from './tools/bash.js'

const targetArg = z.string().min(1).describe('Exact target name from remote_ssh_targets list. Always select the intended host explicitly.')
const resultOf = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })

export function createServer({ storeFile = process.env.REMOTE_SSH_TARGETS_FILE || join(homedir(), '.config', 'remote-ssh', 'targets.json') } = {}) {
  storeFile = resolve(storeFile)
  const server = new McpServer({ name: 'remote-ssh', version: '1.0.0' }, {
    instructions: 'Use remote_ssh_targets to list or manage hosts. Every workspace/job tool requires target. All paths are remote; relative paths use the configured root, which is a working directory, not a sandbox. Authentication may open a local terminal: the user enters passwords/passphrases directly into OpenSSH. Never ask for or pass a password to MCP. Read files before editing. For long commands use bash run_in_background then job_output/job_kill. Job IDs and logs survive MCP restarts; cleanup completed jobs with job_output cleanup:true.',
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
  register('remote_ssh_targets', 'List/add/update/remove SSH targets or connect/disconnect/check a ControlMaster. add/update verify the remote root and may open a terminal for authentication. Changes apply to the next call. No passwords are accepted or stored.', manageSchema,
    (args, signal) => manageTargets(args, storeFile, signal))

  for (const make of [makeReadTool, makeWriteTool, makeEditTool, makeGlobTool, makeGrepTool, makeBashTool]) {
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

  const jobFields = { target: targetArg, job_id: z.uuid() }
  register('job_output', 'Read a remote background job status and output. Reuse next_offset to paginate without duplicates. IDs survive MCP restarts. cleanup:true deletes a finished job after its last output chunk.', z.strictObject({
    ...jobFields, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional(), cleanup: z.boolean().optional(),
  }), async ({ target: name, ...args }, signal) => {
    const target = await findTarget(storeFile, name)
    await readyTarget(target, signal)
    return remoteJob(target, { action: 'output', ...args }, signal)
  }, true)
  register('job_kill', 'Terminate a remote background job process group (TERM, then KILL after 3 seconds). Output remains available through job_output.', z.strictObject(jobFields), async ({ target: name, ...args }, signal) => {
    const target = await findTarget(storeFile, name)
    await readyTarget(target, signal)
    return remoteJob(target, { action: 'kill', ...args }, signal)
  })
  return server
}
