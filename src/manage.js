import * as z from 'zod/v4'
import { parseTargets, targetFields, effectiveControlPersist } from './target.js'
import { readTargetStoreStrict, saveTargetStore, withStoreLock } from './store.js'
import { ensureControlMaster, sshControl, sshExec, shq } from './ssh.js'

export const manageSchema = z.strictObject({
  action: z.enum(['list', 'add', 'update', 'remove', 'connect', 'disconnect', 'status']),
  target: z.string().min(1).optional().describe('Existing target name for update/remove/connect/disconnect/status.'),
  ...Object.fromEntries(Object.entries(targetFields).filter(([key]) => key !== 'port').map(([key, schema]) => [key, schema.optional()])),
  port: targetFields.port.nullable().describe('SSH port; null clears an override on update.'),
  create: z.boolean().optional().describe('Create the remote root if missing. Default false.'),
})

export async function findTarget(storeFile, name) {
  const targets = await readTargetStoreStrict(storeFile)
  const target = targets.find(t => t.name === name)
  if (!target) throw new Error(`No target named "${name}". Use remote_ssh_targets with action "list".`)
  return target
}

export async function readyTarget(target, signal) {
  signal?.throwIfAborted()
  const result = await ensureControlMaster(target, { interactive: true, signal })
  if (!result.ok) throw new Error(result.error + ' Configure REMOTE_SSH_TERMINAL if a terminal cannot be opened.')
  signal?.throwIfAborted()
  return result
}

async function verifyTarget(target, create, signal) {
  await readyTarget(target, signal)
  const command = create ? `mkdir -p -- ${shq(target.root)}` : `test -d ${shq(target.root)}`
  await sshExec({ target: target.ssh, port: target.port, controlPersist: target.controlPersist, command, signal, timeoutMs: 30_000 })
    .catch(error => { throw new Error(`Cannot access remote root ${target.root}: ${error.message}. Use create: true to create it.`) })
}

export async function manageTargets(input, storeFile, signal) {
  const args = manageSchema.parse(input)
  if (args.action === 'list') return { targets: await readTargetStoreStrict(storeFile), storeFile }
  if (args.action !== 'add' && !args.target) throw new Error('target is required for this action.')
  if (['connect', 'disconnect', 'status'].includes(args.action)) {
    const target = await findTarget(storeFile, args.target)
    if (args.action === 'connect') {
      const ready = await readyTarget(target, signal)
      if (ready.mode === 'disabled') await verifyTarget(target, false, signal)
      return { target: target.name, connected: true, mode: ready.mode }
    }
    if (effectiveControlPersist(target) === 0) return { target: target.name, connected: false, detail: 'ControlPersist is disabled; each call uses key/agent authentication.' }
    signal?.throwIfAborted()
    const result = await sshControl(target, args.action === 'status' ? 'check' : 'exit')
    if (args.action === 'disconnect' && result.code !== 0 && !/No such file|Connection refused/i.test(result.stderr)) throw new Error(result.stderr || 'Failed to disconnect.')
    return { target: target.name, connected: args.action === 'status' && result.code === 0, detail: (result.stderr || result.stdout).trim() }
  }
  let before, prepared
  if (args.action !== 'remove') {
    const snapshot = await readTargetStoreStrict(storeFile)
    before = args.action === 'update' ? snapshot.find(t => t.name === args.target) : undefined
    if (args.action === 'update' && !before) throw new Error(`No target named "${args.target}".`)
    const fields = Object.fromEntries(Object.keys(targetFields).filter(key => args[key] !== undefined).map(key => [key, args[key]]))
    const entry = { ...before, ...fields }
    if (args.port === null || (args.ssh !== undefined && args.port === undefined)) delete entry.port
    prepared = parseTargets([entry])[0]
    parseTargets([...snapshot.filter(t => args.action === 'add' || t.name !== args.target), prepared])
    // Network and user interaction must not hold the shared configuration lock.
    await verifyTarget(prepared, args.create === true, signal)
  }
  return withStoreLock(storeFile, async () => {
    signal?.throwIfAborted()
    const targets = await readTargetStoreStrict(storeFile)
    const index = targets.findIndex(t => t.name === args.target)
    if (args.action !== 'add' && index === -1) throw new Error(`No target named "${args.target}".`)
    if (args.action === 'remove') {
      targets.splice(index, 1)
    } else {
      if (before && Object.keys(targetFields).some(key => targets[index][key] !== before[key])) {
        throw new Error(`Target "${args.target}" changed during verification; re-read its settings and retry.`)
      }
      if (args.action === 'add') targets.push(prepared)
      else targets[index] = prepared
      parseTargets(targets) // Recheck concurrent adds/renames before saving.
    }
    signal?.throwIfAborted()
    await saveTargetStore(storeFile, targets)
    return { action: args.action, targets, storeFile }
  })
}
