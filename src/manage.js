import * as z from 'zod/v4'
import { parseTargets, targetFields, effectiveControlPersist } from './target.js'
import { readTargetStoreStrict, saveTargetStore, withStoreLock } from './store.js'
import { ensureControlMaster, sshControl, sshExec, shq } from './ssh.js'
import { clearCachedSudoPassword, sudoCacheKey } from './sudocache.js'

export const manageSchema = z.strictObject({
  action: z.enum(['list', 'add', 'update', 'remove', 'connect', 'disconnect', 'status']),
  target: z.string().min(1).optional().describe('Existing target name for update/remove/connect/disconnect/status.'),
  ...Object.fromEntries(Object.entries(targetFields).filter(([key]) => key !== 'port').map(([key, schema]) => [key, schema.optional()])),
  port: targetFields.port.nullable().describe('SSH port; null clears an override on update, except that an inline port in the same ssh value wins.'),
  create: z.boolean().optional().describe('Create missing root components with mode 0700. Default false. An existing root must be a searchable/executable directory and is not repaired.'),
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
  if (!result.ok) {
    if (result.mode === 'aborted' || signal?.aborted) throw new Error('aborted')
    throw new Error(result.error + ' Configure REMOTE_SSH_TERMINAL if a terminal cannot be opened.')
  }
  signal?.throwIfAborted()
  return result
}

async function verifyTarget(target, create, signal) {
  await readyTarget(target, signal)
  // Require search/execute access, not just existence: a 0000 root is unusable.
  // Create missing components under umask 077 so a restrictive account umask
  // cannot leave the new root unreadable. Sentinels distinguish the cases so
  // the error can point at the real problem.
  const root = shq(target.root)
  const command = create
    ? [
      `if [ -e ${root} ] && [ ! -d ${root} ]; then echo __REMOTE_SSH_ROOT_NOTDIR__ >&2; exit 1; fi`,
      `umask 077; mkdir -p -- ${root} || exit 1`,
      `if [ ! -d ${root} ]; then echo __REMOTE_SSH_ROOT_NOTDIR__ >&2; exit 1; fi`,
      `if [ ! -x ${root} ]; then echo __REMOTE_SSH_ROOT_NOEXEC__ >&2; exit 1; fi`,
    ].join('\n')
    : [
      `if [ ! -e ${root} ]; then echo __REMOTE_SSH_ROOT_MISSING__ >&2; exit 1; fi`,
      `if [ ! -d ${root} ]; then echo __REMOTE_SSH_ROOT_NOTDIR__ >&2; exit 1; fi`,
      `if [ ! -x ${root} ]; then echo __REMOTE_SSH_ROOT_NOEXEC__ >&2; exit 1; fi`,
    ].join('\n')
  await sshExec({ target: target.ssh, port: target.port, controlPersist: target.controlPersist, command, signal, timeoutMs: 30_000 })
    .catch(error => {
      // An abort or a transport failure is not a missing root directory.
      if (signal?.aborted) throw error
      const message = error.message ?? String(error)
      if (/__REMOTE_SSH_ROOT_MISSING__/.test(message)) {
        throw new Error(`Cannot access remote root ${target.root}: it does not exist. Use create: true to create it.`)
      }
      if (/__REMOTE_SSH_ROOT_NOTDIR__/.test(message)) {
        throw new Error(`Cannot access remote root ${target.root}: it is not a directory.`)
      }
      if (/__REMOTE_SSH_ROOT_NOEXEC__/.test(message)) {
        throw new Error(`Cannot access remote root ${target.root}: it exists but is not searchable/executable; fix its permissions (create: true does not change an existing root).`)
      }
      if (/\(exit 1\)/.test(message)) {
        throw new Error(create
          ? `Cannot create remote root ${target.root}: ${message}`
          : `Cannot access remote root ${target.root}: ${message}. Use create: true to create a missing root.`)
      }
      throw new Error(`Cannot verify remote root ${target.root}: ${message}`)
    })
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
    if (effectiveControlPersist(target) === 0) {
      if (args.action === 'disconnect') clearCachedSudoPassword(sudoCacheKey(target))
      return { target: target.name, connected: false, detail: 'ControlPersist is disabled; each call uses key/agent authentication.' }
    }
    signal?.throwIfAborted()
    // Disconnecting is an explicit session teardown: drop this destination's
    // cached sudo password before attempting to close, so a thrown error (for
    // example an unwritable control directory) cannot leave it cached.
    if (args.action === 'disconnect') clearCachedSudoPassword(sudoCacheKey(target))
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
    // Keep the stored port when update merely restates the same destination.
    // Compare normalized forms (bracketed IPv6 is stored without brackets),
    // and let an inline "host:port" replace the stored override.
    const incoming = args.ssh !== undefined ? parseTargets([{ ssh: args.ssh, root: '/' }])[0] : undefined
    const sshChanged = incoming !== undefined && incoming.ssh !== before?.ssh
    if (args.port === null || (args.port === undefined && (sshChanged || incoming?.port !== undefined))) delete entry.port
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
    let droppedCredential
    if (args.action === 'remove') {
      droppedCredential = targets[index]
      targets.splice(index, 1)
    } else {
      if (before && Object.keys(targetFields).some(key => targets[index][key] !== before[key])) {
        throw new Error(`Target "${args.target}" changed during verification; re-read its settings and retry.`)
      }
      // The credential belongs to the destination, not the target name: only
      // an ssh/port change makes the old entry unaddressable.
      if (args.action === 'update' && sudoCacheKey(before) !== sudoCacheKey(prepared)) droppedCredential = before
      if (args.action === 'add') targets.push(prepared)
      else targets[index] = prepared
      parseTargets(targets) // Recheck concurrent adds/renames before saving.
    }
    signal?.throwIfAborted()
    await saveTargetStore(storeFile, targets)
    if (droppedCredential) clearCachedSudoPassword(sudoCacheKey(droppedCredential))
    return { action: args.action, targets, storeFile }
  }, { signal })
}
