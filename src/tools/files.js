/** One-shot remote file operations; all paths are resolved on the remote host. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { sshExec, shq } from '../ssh.js'
import { resolveRemote } from '../target.js'
import { checkArgs, defTextTool } from '../toolkit.js'

const FILE_SCRIPT = readFileSync(new URL('../files.py', import.meta.url), 'utf8')
const MAX_READ_LINES = 2000

async function remoteFile(target, action, path, args, stdin, signal) {
  const output = await sshExec({
    target: target.ssh, port: target.port, controlPersist: target.controlPersist,
    command: `python3 -c ${shq(FILE_SCRIPT)} ${[action, path, ...args].map(shq).join(' ')}`,
    stdin, signal,
  }).catch(error => { throw new Error(`${action}: ${path}: ${error.message}`) })
  try {
    return JSON.parse(output.toString('utf8'))
  } catch {
    throw new Error(`${action}: unexpected remote output for ${path}`)
  }
}

/** Reject NUL bytes and unpaired UTF-16 surrogates before encoding UTF-8. */
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

function renderNumbered(path, result, offset) {
  const { text, total_lines: total, returned_lines: count, byte_limited: capped, next_offset: next } = result
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n')
  const numbered = lines.map((line, i) => `${offset + i}\t${line}`).join('\n')
  const end = offset + count - 1
  const footer = count === 0
    ? (total > 0 ? `(Offset ${offset} is past end of file - total ${total} lines)` : '(File is empty)')
    : end >= total
      ? `(End of file - total ${total} lines)`
      : `(Showing lines ${offset}-${end} of ${total}. Use offset=${next} to continue.)`
  const note = capped ? '\n[truncated at the 1 MiB read limit; only complete lines are shown]' : ''
  return `<path>${path}</path>\n<content>\n${numbered}\n</content>\n${footer}${note}`
}

export function makeReadTool(target, cwd = target.root) {
  return defTextTool({
    name: 'read',
    description: 'Read a UTF-8 text file with accurate line numbers. Returns at most 2000 complete lines and 1 MiB, with a continuation offset when capped. A single line exceeding 1 MiB is rejected. REMOTE: the path lives on the selected Linux host.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read on the selected remote host. A relative path resolves against the target root.' },
        offset: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: 'Maximum number of lines to return. Defaults to and is capped at 2000.' },
      },
      required: ['file_path'],
    },
    async execute(args, exec) {
      const a = checkArgs('read', args, { file_path: 'string', offset: '?integer', limit: '?integer' })
      const offset = a.offset ?? 1
      const limit = a.limit ?? MAX_READ_LINES
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('read: offset must be a positive safe integer')
      if (limit < 1 || limit > MAX_READ_LINES) throw new Error(`read: limit must be between 1 and ${MAX_READ_LINES}`)
      const path = resolveRemote(a.file_path, cwd)
      return renderNumbered(path, await remoteFile(target, 'read', path, [offset, limit], undefined, exec.signal), offset)
    },
  })
}

export function makeWriteTool(target, cwd = target.root) {
  return defTextTool({
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file. Upload byte count and SHA-256 are verified before atomic replacement; new files use mode 0600 and existing permission bits are preserved. REMOTE: parent directories are created on the selected Linux host.',
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
      const digest = createHash('sha256').update(buf).digest('hex')
      // Raw stdin avoids Base64's bandwidth/copy overhead. The remote helper
      // verifies both size and digest, including on early EOF, before commit.
      await remoteFile(target, 'write', path, [buf.length, digest], buf, exec.signal)
      return `File written to remote host ${target.name}: ${path} (${buf.length} bytes)`
    },
  })
}

export function makeEditTool(target, cwd = target.root) {
  return defTextTool({
    name: 'edit',
    description: 'Replace literal text in an existing remote UTF-8 file. Read the file first. Matching, replacement and atomic write run in one SSH call; only edit parameters are uploaded. Input and result are capped at 4 MiB. An inode/mtime/ctime/size check detects some concurrent changes but is not a lock; on conflict, re-read and reconcile.',
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
      const a = checkArgs('edit', args, { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: '?boolean' })
      if (a.old_string.length === 0) throw new Error('edit: old_string must be a non-empty string')
      if (hasBinaryContent(a.old_string)) throw new Error('edit: old_string must be UTF-8 text (NUL bytes or truncated characters are not allowed)')
      if (hasBinaryContent(a.new_string)) throw new Error('edit: new_string must be UTF-8 text (NUL bytes or truncated characters are not allowed)')
      const path = resolveRemote(a.file_path, cwd)
      const { replaced } = await remoteFile(target, 'edit', path, [], JSON.stringify({
        old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all === true,
      }), exec.signal)
      return `Edited remote host ${target.name}: ${path} (replaced ${replaced} occurrence${replaced === 1 ? '' : 's'})`
    },
  })
}
