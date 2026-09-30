/**
 * read.js / write.js / edit.js — remote file tools (pi-style, one ssh per call).
 *
 * All paths are remote. Relative paths resolve against the target root.
 */

import { randomUUID } from 'node:crypto'
import { sshExec, sshRun, shq } from '../ssh.js'
import { resolveRemote, remoteDirname } from '../target.js'
import { checkArgs, defTextTool } from '../toolkit.js'

const MAX_EDIT_FILE_BYTES = 4 * 1024 * 1024

/** Remote temp file name for an atomic write (same dir, then `mv -f`). */
function tmpPathFor(path) {
  return `${path}.remote-ssh-tmp-${randomUUID()}`
}

/**
 * Build the remote script for an ATOMIC write: base64-decode stdin into a
 * temp file in the same directory, then `mv -f` it over the target (rename
 * is atomic on POSIX — readers never see a truncated file). The target's
 * permissions are carried over when it already exists (a plain `>` would
 * have kept its inode; the mv swap must not silently loosen them). The temp
 * file is removed on any failure.
 * `guard` is an optional `[ "$(stat…)" = '<mtime> <size>' ]` precondition
 * (edit's TOCTOU check): when it fails the script exits 4 with a
 * __REMOTE_SSH_CHANGED__ marker on stderr and the target stays untouched.
 */
function atomicWriteScript({ path, tmp, guard }) {
  const lines = [
    `if base64 -d > ${shq(tmp)}; then`,
  ]
  if (guard !== undefined) {
    lines.push(
      `  if [ "$(stat -c '%y %s' -- ${shq(path)} 2>/dev/null)" = ${shq(guard)} ]; then`,
      `    chmod --reference=${shq(path)} ${shq(tmp)} 2>/dev/null || true`,
      `    if mv -f ${shq(tmp)} ${shq(path)}; then exit 0; else rm -f ${shq(tmp)}; exit 1; fi`,
      `  else`,
      `    rm -f ${shq(tmp)}`,
      `    printf '%s\\n' ${shq(`__REMOTE_SSH_CHANGED__: ${path} changed on the remote host during the edit`)} >&2`,
      `    exit 4`,
      `  fi`,
    )
  } else {
    lines.push(
      `  { [ ! -e ${shq(path)} ] || chmod --reference=${shq(path)} ${shq(tmp)} 2>/dev/null || true; }`,
      `  if mv -f ${shq(tmp)} ${shq(path)}; then exit 0; else rm -f ${shq(tmp)}; exit 1; fi`,
    )
  }
  lines.push(
    `else`,
    `  rc=$?; rm -f ${shq(tmp)}; exit $rc`,
    `fi`,
  )
  return lines.join('\n')
}

/**
 * True when `s` carries bytes that can't be valid UTF-8 text: a NUL byte or a
 * lone UTF-16 surrogate (which cannot round-trip through UTF-8).
 * @param {string} s
 * @returns {boolean}
 */
export function hasBinaryContent(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0) return true
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

/** Render numbered lines exactly like the stock read tool. */
function renderNumbered(path, text, offset, totalLines) {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  const numbered = lines.map((l, i) => `${offset + i}\t${l}`).join('\n')
  const end = offset + lines.length - 1
  const footer = lines.length === 0
    ? (totalLines > 0 ? `(Offset ${offset} is past end of file - total ${totalLines} lines)` : '(File is empty)')
    : end >= totalLines
      ? `(End of file - total ${totalLines} lines)`
      : `(Showing lines ${offset}-${end} of ${totalLines}. Use offset to continue.)`
  return `<path>${path}</path>\n<content>\n${numbered}\n</content>\n${footer}`
}

export function makeReadTool(target, cwd = target.root) {
  return defTextTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content. The remote host must run Linux. REMOTE: the path lives on the selected host, and the read runs there.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read on the selected remote host. A relative path resolves against the target root.' },
        offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' },
      },
      required: ['file_path'],
    },
    async execute(args, exec) {
      const a = checkArgs('read', args, { file_path: 'string', offset: '?integer', limit: '?integer' })
      const offset = a.offset ?? 1
      const limit = a.limit ?? 2000
      if (offset < 1) throw new Error('read: offset must be >= 1')
      if (limit < 1) throw new Error('read: limit must be >= 1')
      const path = resolveRemote(a.file_path, cwd)
      const end = offset + limit - 1
      // One round trip: the requested window first, then a per-call random
      // separator and the total line count LAST — when the window exceeds
      // sshRun's 4 MiB stdout cap the tail is kept, so the count and the
      // separator always survive (a head-located count would be truncated
      // away). Error states ride a stdout marker (never inferred from exit
      // codes). `wc -l` counts newlines, so a file without a trailing
      // newline is corrected by one (tail -c 1 is empty iff the file ends
      // with \n or is empty).
      const sep = `__REMOTE_SSH_SEP_${randomUUID().replace(/-/g, '')}__`
      const script = [
        `if [ -d ${shq(path)} ]; then echo "__REMOTE_SSH_ERR__:is-a-directory"`,
        `elif [ ! -f ${shq(path)} ]; then echo "__REMOTE_SSH_ERR__:not-found"`,
        `else sed -n '${offset},${end}p' ${shq(path)}; echo; echo ${shq(sep)}; n=$(wc -l < ${shq(path)}); [ -n "$(tail -c 1 ${shq(path)})" ] && n=$((n + 1)); echo "$n"; fi`,
      ].join('\n')
      const r = await sshRun({ target: target.ssh, port: target.port, command: script, signal: exec.signal, controlPersist: target.controlPersist })
      if (r.timedOut) throw new Error(`read: timed out reading ${path} on ${target.name}`)
      const raw = r.stdout
      if (raw.startsWith('__REMOTE_SSH_ERR__:is-a-directory')) throw new Error(`read: ${path} is a directory`)
      if (raw.startsWith('__REMOTE_SSH_ERR__:not-found')) throw new Error(`read: file not found: ${path}`)
      // The separator sits between body and count; the `echo` before it
      // contributes exactly one '\n', so slicing at the LAST separator line
      // keeps the body's own trailing newline (or lack of it) intact.
      const sepMark = `\n${sep}\n`
      const sepAt = raw.lastIndexOf(sepMark)
      if (sepAt === -1) throw new Error(`read: unexpected remote output for ${path}: ${raw.slice(0, 120)}`)
      const totalLines = parseInt(raw.slice(sepAt + sepMark.length).trim(), 10)
      const body = raw.slice(0, sepAt)
      // cheap binary sniff in the first window: the U+FFFD replacement char
      // (Buffer's utf8 decode turns invalid byte sequences into it) or C0/C1
      // control chars outside tab/lf/cr. A keepTail-truncated window may
      // start mid-character, so a leading U+FFFD run is ignored first.
      const sniff = body.slice(0, 8000).replace(/^\uFFFD+/, '')
      if (sniff.includes('\uFFFD') || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(sniff)) {
        throw new Error(`read: ${path} does not look like a UTF-8 text file`)
      }
      return renderNumbered(path, body, offset, Number.isFinite(totalLines) ? totalLines : end)
    },
  })
}

export function makeWriteTool(target, cwd = target.root) {
  return defTextTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file. The remote host must run Linux. REMOTE: the file is written on the selected host (parent directories are created).',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to write on the selected remote host. A relative path resolves against the target root.' },
        content: { type: 'string', description: 'Full UTF-8 text content to write.' },
      },
      required: ['file_path', 'content'],
    },
    async execute(args, exec) {
      const a = checkArgs('write', args, { file_path: 'string', content: 'string' })
      if (hasBinaryContent(a.content)) throw new Error('write: content must be UTF-8 text (NUL bytes or truncated characters are not allowed)')
      const path = resolveRemote(a.file_path, cwd)
      const buf = Buffer.from(a.content, 'utf8')
      // base64 over stdin: binary-safe, no argv size limits. The write is
      // ATOMIC: decode into a temp file in the same directory, then mv -f
      // over the target (a direct `>` would truncate the file first).
      await sshExec({
        target: target.ssh, port: target.port,
        controlPersist: target.controlPersist,
        command: `mkdir -p ${shq(remoteDirname(path))}\n${atomicWriteScript({ path, tmp: tmpPathFor(path) })}`,
        stdin: buf.toString('base64'),
        signal: exec.signal,
      })
      return `File written to remote host ${target.name}: ${path} (${buf.length} bytes)`
    },
  })
}

export function makeEditTool(target, cwd = target.root) {
  return defTextTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing literal text. The remote host must run Linux. REMOTE: the edit is applied on the selected host. Read the file first (the read-before-edit policy still applies by convention).',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to edit on the selected remote host. A relative path resolves against the target root.' },
        old_string: { type: 'string', description: 'Literal text to replace. Must match exactly.' },
        new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async execute(args, exec) {
      const a = checkArgs('edit', args, {
        file_path: 'string', old_string: 'string', new_string: 'string', replace_all: '?boolean',
      })
      if (a.old_string.length === 0) throw new Error('edit: old_string must be a non-empty string')
      if (hasBinaryContent(a.old_string)) throw new Error('edit: old_string must be UTF-8 text (NUL bytes or truncated characters are not allowed)')
      if (hasBinaryContent(a.new_string)) throw new Error('edit: new_string must be UTF-8 text (NUL bytes or truncated characters are not allowed)')
      const path = resolveRemote(a.file_path, cwd)
      // The stat line (mtime + size) rides ahead of the base64 payload so the
      // write-back can refuse a file that changed under the read-modify-write
      // (TOCTOU guard).
      const raw = await sshExec({
        target: target.ssh, port: target.port,
        controlPersist: target.controlPersist,
        command: `test -f ${shq(path)} && { stat -c '%y %s' -- ${shq(path)}; head -c ${MAX_EDIT_FILE_BYTES + 1} ${shq(path)} | base64; }`,
        signal: exec.signal,
      }).catch((e) => { throw new Error(`edit: cannot read ${path}: ${e.message}`) })
      const text = raw.toString('utf8')
      const nl = text.indexOf('\n')
      const stamp = nl === -1 ? '' : text.slice(0, nl).trim()
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ [+-]\d{4} \d+$/.test(stamp)) {
        throw new Error(`edit: unexpected remote output while stating ${path}: ${text.slice(0, 120)}`)
      }
      const bytes = Buffer.from(text.slice(nl + 1).replace(/\s/g, ''), 'base64')
      if (bytes.length > MAX_EDIT_FILE_BYTES) {
        throw new Error(`edit: ${path} exceeds ${MAX_EDIT_FILE_BYTES} bytes; remote edit refuses oversized files`)
      }
      let content
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        throw new Error(`edit: ${path} does not look like a UTF-8 text file (invalid encoding)`)
      }
      if (content.includes('\0')) {
        throw new Error(`edit: ${path} does not look like a UTF-8 text file (binary data)`)
      }
      const count = content.split(a.old_string).length - 1
      if (count === 0) throw new Error(`edit: old_string not found in ${path}`)
      if (count > 1 && a.replace_all !== true) {
        throw new Error(`edit: old_string appears ${count} times in ${path}; provide a more specific old_string or set replace_all to true`)
      }
      const next = a.replace_all === true
        ? content.split(a.old_string).join(a.new_string)
        : content.replace(a.old_string, () => a.new_string)
      const buf = Buffer.from(next, 'utf8')
      // Atomic write-back, guarded: the remote mtime/size must still equal
      // what the read observed, or another writer raced this edit and the
      // replace would silently clobber their change.
      await sshExec({
        target: target.ssh, port: target.port,
        controlPersist: target.controlPersist,
        command: atomicWriteScript({ path, tmp: tmpPathFor(path), guard: stamp }),
        stdin: buf.toString('base64'),
        signal: exec.signal,
      }).catch((e) => {
        if (e.message.includes('__REMOTE_SSH_CHANGED__')) {
          throw new Error(`edit: ${path} changed on the remote host between read and write (mtime/size differ) — re-read the file and retry the edit`)
        }
        throw e
      })
      const replaced = a.replace_all === true ? count : 1
      return `Edited remote host ${target.name}: ${path} (replaced ${replaced} occurrence${replaced === 1 ? '' : 's'})`
    },
  })
}
