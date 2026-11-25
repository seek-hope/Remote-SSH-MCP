import { posix } from 'node:path'
import * as z from 'zod/v4'

const DEFAULT_CONTROL_PERSIST_SECONDS = 43_200
const MAX_CONTROL_PERSIST_SECONDS = 31_536_000

/** True when the string contains a UTF-16 surrogate that has no pair. */
function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export const targetFields = {
  name: z.string().trim().min(1)
    .refine(value => !hasUnpairedSurrogate(value), 'Target name must not contain unpaired UTF-16 surrogates.')
    .optional().describe('Unique target name; defaults to the SSH destination.'),
  // Keep this pattern portable: providers compile tool schemas with non-JavaScript
  // engines that reject lookaround (e.g. "^(?!-)") and bare "\0" escapes.
  ssh: z.string().trim().min(1)
    .regex(/^[^-\s\x00][^\s\x00]*$/, 'Expected an SSH alias or user@host, not an option.')
    .refine(value => !hasUnpairedSurrogate(value), 'SSH destination must not contain unpaired UTF-16 surrogates.')
    .describe('SSH alias or user@host; host:port and [IPv6]:port are accepted. Uses ~/.ssh/config.'),
  port: z.number().int().min(1).max(65535).optional(),
  root: z.string().startsWith('/').refine(p => !p.includes('\0') && !p.split('/').includes('..') && !hasUnpairedSurrogate(p), 'Root must be an absolute remote path without NUL, .. segments, or unpaired UTF-16 surrogates.').describe('Default remote working directory, not a filesystem sandbox.'),
  controlPersist: z.number().int().min(0).max(MAX_CONTROL_PERSIST_SECONDS).nullable().optional().describe('Connection reuse in seconds; default 43200. 0/null disables reuse and requires noninteractive key/agent authentication.'),
}

const targetSchema = z.strictObject(targetFields).transform(entry => {
  let { ssh, port } = entry
  const inline = ssh.match(/^([^:]+|.*\]):(\d+)$/u)
  if (inline) {
    ssh = inline[1]
    port ??= Number(inline[2])
  }
  // OpenSSH accepts bare IPv6; brackets only disambiguate the inline port.
  ssh = ssh.replace(/^(.*@)?\[([^\]]+)\]$/, '$1$2')
  if (port !== undefined) targetFields.port.parse(port)
  return { ...entry, ssh, port, name: entry.name ?? ssh, root: posix.normalize(entry.root).replace(/\/$/, '') || '/', controlPersist: entry.controlPersist === null ? 0 : entry.controlPersist }
})

export function parseTargets(raw) {
  const targets = z.array(targetSchema).parse(raw)
  const names = new Set()
  for (const target of targets) {
    if (names.has(target.name)) throw new Error(`Duplicate target name: ${target.name}`)
    names.add(target.name)
  }
  return targets
}

export function effectiveControlPersist(target) {
  const value = target?.controlPersist
  if (value === undefined) return DEFAULT_CONTROL_PERSIST_SECONDS
  return Number.isInteger(value) && value > 0 ? value : 0
}

export function resolveRemote(path, cwd) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Path must be a non-empty string without NUL.')
  return posix.resolve(cwd, path)
}

export const remoteDirname = posix.dirname
