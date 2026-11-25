/**
 * search.js — remote glob & grep.
 *
 * glob uses remote python3; grep uses remote GNU grep.
 */

import { sshRun, shq } from '../ssh.js'
import { resolveRemote } from '../target.js'
import { checkArgs, defTextTool } from '../toolkit.js'

const GLOB_CAP = 100
const GREP_CAP = 250
/** Bound the result text so JSON escaping cannot exceed the MCP buffer. */
const MAX_GREP_BYTES = 512 * 1024
const MAX_GREP_LINE_CHARS = 8 * 1024

/**
 * Python 3.9-compatible glob walker. Reads pattern and root from argv,
 * prints matching absolute paths (mtime desc, capped) then a total marker.
 * `**` crosses directories, `*`/`?` stay within one path segment,
 * `{a,b}` alternation supported. .git/.svn/.hg are skipped.
 */
export const GLOB_PY = String.raw`
import heapq, os, re, sys

pattern, root, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])

def translate(pat):
    out, i, n = [], 0, len(pat)
    while i < n:
        c = pat[i]
        if c == '*':
            if i + 1 < n and pat[i + 1] == '*':
                # '**/' or trailing '**'
                if i + 2 < n and pat[i + 2] == '/':
                    out.append('(?:.*/)?'); i += 3
                else:
                    out.append('.*'); i += 2
            else:
                out.append('[^/]*'); i += 1
        elif c == '?':
            out.append('[^/]'); i += 1
        elif c == '{':
            j = pat.find('}', i)
            if j == -1:
                out.append(re.escape(c)); i += 1
            else:
                alts = [translate(p) for p in pat[i + 1:j].split(',')]
                out.append('(?:' + '|'.join(alts) + ')'); i = j + 1
        elif c == '[':
            j = pat.find(']', i)
            if j == -1:
                out.append(re.escape(c)); i += 1
            else:
                cls = pat[i + 1:j]
                if cls.startswith('!'):
                    cls = '^' + cls[1:]
                out.append('[' + cls + ']'); i = j + 1
        else:
            out.append(re.escape(c)); i += 1
    return ''.join(out)

rx = re.compile('^' + translate(pattern) + r'\Z')
basename_mode = '/' not in pattern
results = []
total = 0
skipped_dirs = {'.git', '.svn', '.hg', 'node_modules'}
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in skipped_dirs]
    for name in filenames:
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root)
        subject = name if basename_mode else rel
        if rx.match(subject):
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                mtime = 0.0
            # Keep only the best cap entries. The sequence breaks equal-mtime
            # ties in the same traversal order as the previous stable sort.
            item = (mtime, -total, full)
            total += 1
            if len(results) < cap:
                heapq.heappush(results, item)
            elif item > results[0]:
                heapq.heapreplace(results, item)
for _, _, p in sorted(results, reverse=True):
    try:
        p.encode('utf-8')
    except UnicodeEncodeError:
        # A filename that is not valid UTF-8 cannot round-trip through the
        # text MCP transport; skip it instead of crashing the whole search.
        continue
    sys.stdout.buffer.write(os.fsencode(p) + b'\0')
sys.stdout.buffer.write(('__REMOTE_SSH_TOTAL__%d\n' % total).encode('ascii'))
sys.stdout.buffer.flush()
`.trim()

export function makeGlobTool(target, cwd = target.root) {
  return defTextTool({
    name: 'glob',
    description: `Find files whose paths match a glob pattern. Returns matching file paths — never directories — in newest-modification-first order, up to ${GLOB_CAP} paths. The remote host must run Linux. REMOTE: the search runs on the selected host; .git/.svn/.hg/node_modules directories are skipped.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match file paths against (e.g. "**/*.ts"). A pattern with no "/" matches the basename at any depth; include a separator to anchor the depth.' },
        path: { type: 'string', description: 'Directory to search in, on the selected remote host. Defaults to the target root; a relative path resolves against it.' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const a = checkArgs('glob', args, { pattern: 'string', path: '?string' })
      const root = resolveRemote(a.path ?? '.', cwd)
      const r = await sshRun({
        target: target.ssh, port: target.port,
        controlPersist: target.controlPersist,
        command: `test -d ${shq(root)} && python3 -c ${shq(GLOB_PY)} ${shq(a.pattern)} ${shq(root)} ${GLOB_CAP}`,
        signal: exec.signal,
      })
      if (r.timedOut) throw new Error(`glob: search timed out on ${target.name}`)
      if (r.code !== 0) throw new Error(`glob: search failed on ${target.name}: ${r.stderr.trim() || r.stdout.slice(-120)}`)
      if (r.stdoutTruncated) throw new Error('glob: output exceeded the transport limit; narrow the pattern or path')
      // Paths are NUL-delimited so filenames containing newlines stay intact;
      // the total marker is the text after the last NUL.
      const parts = r.stdout.split('\0')
      const tail = parts.pop() ?? ''
      const paths = parts.filter(Boolean)
      const marker = tail.trim().split('\n').filter(Boolean).pop() ?? ''
      if (!marker.startsWith('__REMOTE_SSH_TOTAL__')) throw new Error(`glob: unexpected remote output (no total marker)`)
      const total = parseInt(marker.slice('__REMOTE_SSH_TOTAL__'.length), 10)
      if (paths.length === 0) {
        if (Number.isFinite(total) && total > 0) {
          return `${total} path(s) matched "${a.pattern}" under ${root}, but none of the selected newest names is representable as UTF-8.`
        }
        return `No files matched "${a.pattern}" under ${root} (remote host ${target.name}).`
      }
      const header = Number.isFinite(total) && total > paths.length
        ? `Showing ${paths.length} of ${total} matches (mtime order, capped).`
        : `${paths.length} match${paths.length === 1 ? '' : 'es'}.`
      return `${header}\n${paths.join('\n')}`
    },
  })
}

export function makeGrepTool(target, cwd = target.root) {
  return defTextTool({
    name: 'grep',
    description: `Search file contents with a regular expression (POSIX ERE on the remote grep; ripgrep-only syntax like \\p{...} is unsupported). Returns matching lines with line numbers, grouped by file, capped at ${GREP_CAP} matches and 512 KiB of encoded output; very long lines are shortened. The remote host must run Linux. REMOTE: the search runs on the selected host; binary files and .git/node_modules directories are skipped.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (extended regex).' },
        path: { type: 'string', description: 'File or directory to search, on the selected remote host. Defaults to the target root; a relative path resolves against it.' },
        include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts"). Not a list; negation is not supported.' },
      },
      required: ['pattern'],
    },
    async execute(args, exec) {
      const a = checkArgs('grep', args, { pattern: 'string', path: '?string', include: '?string' })
      const root = resolveRemote(a.path ?? '.', cwd)
      const include = a.include ? ` --include=${shq(a.include)}` : ''
      // Keep grep errors distinct from no matches; SIGPIPE is expected at the cap.
      const search = `grep -rHInE --null${include} --exclude-dir=.git --exclude-dir=node_modules -e ${shq(a.pattern)} -- ${shq(root)} | head -n ${GREP_CAP + 1}; rc=\${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || [ "$rc" -eq 141 ]`
      const script = [
        `if [ ! -e ${shq(root)} ]; then echo "__REMOTE_SSH_ERR__:no-such-path"`,
        `else bash -c ${shq(search)}; fi`,
      ].join('\n')
      const r = await sshRun({ target: target.ssh, port: target.port, command: script, signal: exec.signal, controlPersist: target.controlPersist })
      if (r.timedOut) throw new Error(`grep: search timed out on ${target.name}`)
      if (r.code !== 0) throw new Error(`grep: search failed on ${target.name}: ${r.stderr.trim() || 'remote command did not complete'}`)
      if (r.stdoutTruncated) throw new Error('grep: output exceeded the transport limit; narrow the pattern or path (very long matching lines)')
      const raw = r.stdout
      if (raw.startsWith('__REMOTE_SSH_ERR__:no-such-path')) throw new Error(`grep: no such path on ${target.name}: ${root}`)
      // GNU grep --null writes `filename\0line:text\n` per match. Parse from
      // the NUL so a newline inside a filename cannot split the record (and
      // a suffix of the name is never reported as a separate file).
      const records = []
      let rawCount = 0
      let malformed = 0
      for (let pos = 0; pos < raw.length;) {
        const nul = raw.indexOf('\0', pos)
        if (nul === -1) {
          malformed += 1
          break
        }
        const newline = raw.indexOf('\n', nul + 1)
        const end = newline === -1 ? raw.length : newline
        const file = raw.slice(pos, nul)
        const body = raw.slice(nul + 1, end)
        rawCount += 1
        if (file.includes('\uFFFD')) {
          // Invalid UTF-8 filename: later tools could not address it.
          malformed += 1
        } else if (file || body) {
          records.push({ file, body })
        }
        pos = newline === -1 ? raw.length : newline + 1
      }
      // Count raw records (including skipped ones): head passes GREP_CAP+1,
      // so a malformed sentinel record must still signal truncation.
      const truncated = rawCount > GREP_CAP
      const shown = records.slice(0, GREP_CAP)
      // group path:line:text by file, preserving order
      const groups = new Map()
      let bytes = 0
      let cut = false
      for (const { file, body } of shown) {
        const m = body.match(/^(\d+):(.*)$/)
        if (!m) {
          malformed += 1
          continue
        }
        const text = m[2].length > MAX_GREP_LINE_CHARS ? `${m[2].slice(0, MAX_GREP_LINE_CHARS)}...[line truncated]` : m[2]
        const record = `${m[1]}:${text}`
        const cost = Buffer.byteLength(JSON.stringify(file)) + Buffer.byteLength(JSON.stringify(record)) + 4
        if (bytes + cost > MAX_GREP_BYTES) {
          cut = true
          break
        }
        bytes += cost
        if (!groups.has(file)) groups.set(file, [])
        groups.get(file).push(record)
      }
      const body = [...groups.entries()].map(([f, ls]) => `${f}\n${ls.join('\n')}`).join('\n\n')
      const notes = []
      if (truncated) notes.push(`[truncated at ${GREP_CAP} matches; narrow the pattern or path]`)
      if (cut) notes.push(`[output truncated at ${Math.round(MAX_GREP_BYTES / 1024)} KiB; narrow the pattern or path]`)
      if (malformed) notes.push(`[${malformed} record(s) skipped: non-UTF-8/unrepresentable filenames or unparseable output]`)
      const note = notes.length ? `\n${notes.join('\n')}` : ''
      if (!body) return `No parseable matches for /${a.pattern}/ under ${root} (remote host ${target.name}).${note}`
      return `${body}${note}`
    },
  })
}
