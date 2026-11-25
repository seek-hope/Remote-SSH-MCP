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
import heapq, os, re, stat, sys

pattern, root, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])

# Distinguish a missing root from an existing file and from an inaccessible
# one; a shell [ -d ] check collapses all three into "no such directory".
try:
    root_stat = os.stat(root)
except FileNotFoundError:
    sys.stderr.write('__REMOTE_SSH_ERR__:no-such-dir\n')
    sys.exit(2)
except NotADirectoryError:
    sys.stderr.write('__REMOTE_SSH_ERR__:not-a-dir\n')
    sys.exit(2)
except PermissionError:
    sys.stderr.write('__REMOTE_SSH_ERR__:permission\n')
    sys.exit(2)
except OSError as error:
    sys.stderr.write('glob: %s\n' % error)
    sys.exit(2)
if not stat.S_ISDIR(root_stat.st_mode):
    sys.stderr.write('__REMOTE_SSH_ERR__:not-a-dir\n')
    sys.exit(2)

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
            # POSIX allows ']' as the first class member ([]] matches ']'),
            # and '!' negation before it ([!]]). A naive first-']' search
            # produces invalid regexes for those forms.
            j = i + 1
            if j < n and pat[j] in ('!', '^'):
                j += 1
            if j < n and pat[j] == ']':
                j += 1
            j = pat.find(']', j)
            if j == -1:
                out.append(re.escape(c)); i += 1
            else:
                cls = pat[i + 1:j]
                if cls.startswith('!'):
                    cls = '^' + cls[1:]
                # The class is inserted verbatim; a backslash would otherwise
                # become a regex escape that the glob did not request.
                cls = cls.replace('\\', '\\\\')
                out.append('[' + cls + ']'); i = j + 1
        else:
            out.append(re.escape(c)); i += 1
    return ''.join(out)

try:
    # re.S lets ** (translated to .*) cross newlines in path names; a
    # single * uses [^/]* and already does. Literal dots are escaped.
    rx = re.compile('^' + translate(pattern) + r'\Z', re.S)
except re.error:
    # A malformed class/range must not print a Python traceback to the user.
    sys.stderr.write('__REMOTE_SSH_ERR__:bad-pattern\n')
    sys.exit(2)
basename_mode = '/' not in pattern
results = []
total = 0
skipped_dirs = {'.git', '.svn', '.hg', 'node_modules'}
# Report unreadable directories instead of silently returning "no files".
def onerror(error):
    sys.stderr.write('glob: %s\n' % error)
    sys.exit(2)
for dirpath, dirnames, filenames in os.walk(root, onerror=onerror):
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
            total += 1
            try:
                full.encode('utf-8')
            except UnicodeEncodeError:
                # Keep the match in the total, but choose the top-k from names
                # the text transport can represent, so an older representable
                # file is not evicted by newer unrepresentable ones.
                continue
            # Keep only the best cap entries. The sequence breaks equal-mtime
            # ties in the same traversal order as the previous stable sort.
            item = (mtime, -total, full)
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
        command: `PYTHONUTF8=1 python3 -c ${shq(GLOB_PY)} ${shq(a.pattern)} ${shq(root)} ${GLOB_CAP}`,
        signal: exec.signal,
      })
      if (r.timedOut) throw new Error(`glob: search timed out on ${target.name}`)
      if (r.code !== 0) {
        if (r.stderr.includes('__REMOTE_SSH_ERR__:no-such-dir')) throw new Error(`glob: no such directory on ${target.name}: ${root}`)
        if (r.stderr.includes('__REMOTE_SSH_ERR__:not-a-dir')) throw new Error(`glob: not a directory on ${target.name}: ${root}`)
        if (r.stderr.includes('__REMOTE_SSH_ERR__:permission')) throw new Error(`glob: permission denied on ${target.name}: ${root}`)
        if (r.stderr.includes('__REMOTE_SSH_ERR__:bad-pattern')) throw new Error(`glob: invalid pattern: ${a.pattern}`)
        throw new Error(`glob: search failed on ${target.name}: ${r.stderr.trim() || r.stdout.slice(-120)}`)
      }
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
          return `${total} path(s) matched "${a.pattern}" under ${root}, but none is representable as UTF-8.`
        }
        return `No files matched "${a.pattern}" under ${root} (remote host ${target.name}).`
      }
      const header = Number.isFinite(total) && total > paths.length
        ? `Showing ${paths.length} of ${total} matches (newest representable paths; non-UTF-8 names are skipped).`
        : `${paths.length} match${paths.length === 1 ? '' : 'es'}.`
      return `${header}\n${paths.join('\n')}`
    },
  })
}

export function makeGrepTool(target, cwd = target.root) {
  return defTextTool({
    name: 'grep',
    description: `Search file contents with a regular expression (POSIX ERE on the remote grep; ripgrep-only syntax like \\p{...} is unsupported). Returns matching lines with line numbers, grouped by file, capped at ${GREP_CAP} matches and 512 KiB of encoded output; very long lines are shortened without splitting surrogate pairs. The remote host must run Linux with GNU grep and coreutils 8.25+ (head -z). REMOTE: the search runs on the selected host; binary files and .git/node_modules directories are skipped.`,
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
      // `head -n` counts newlines, and a filename may contain one; use NUL
      // records so 251 complete `filename\0line:text\n` records are passed
      // (the 251st NUL terminates the sentinel filename, preserving the cap
      // signal even when it is unparseable or non-UTF-8).
      const search = `grep -rHInE -D skip --null${include} --exclude-dir=.git --exclude-dir=node_modules -e ${shq(a.pattern)} -- ${shq(root)} | head -z -n ${GREP_CAP + 1}; st=("\${PIPESTATUS[@]}"); rc=\${st[0]}; [ "\${st[1]}" -eq 0 ] || { echo "grep: head -z failed (GNU coreutils 8.25+ required)" >&2; exit 3; }; [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || [ "$rc" -eq 141 ]`
      // A shell existence test cannot distinguish missing from EACCES, and a
      // FIFO/device root would block grep. Accept only a directory or regular
      // file; classify everything else without opening it.
      const script = [
        `if [ -d ${shq(root)} ] || [ -f ${shq(root)} ]; then bash -c ${shq(search)}`,
        `elif [ -e ${shq(root)} ]; then echo "__REMOTE_SSH_ERR__:not-regular"`,
        `else echo "__REMOTE_SSH_ERR__:no-such-path"; fi`,
      ].join('\n')
      const r = await sshRun({ target: target.ssh, port: target.port, command: script, signal: exec.signal, controlPersist: target.controlPersist })
      if (r.timedOut) throw new Error(`grep: search timed out on ${target.name}`)
      if (r.code !== 0) throw new Error(`grep: search failed on ${target.name}: ${r.stderr.trim() || 'remote command did not complete'}`)
      if (r.stdoutTruncated) throw new Error('grep: output exceeded the transport limit; narrow the pattern or path (very long matching lines)')
      const raw = r.stdout
      if (raw.startsWith('__REMOTE_SSH_ERR__:no-such-path')) throw new Error(`grep: no such path or not accessible on ${target.name}: ${root}`)
      if (raw.startsWith('__REMOTE_SSH_ERR__:not-regular')) throw new Error(`grep: not a regular file or directory on ${target.name}: ${root}`)
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
        // CRLF (and U+2028/U+2029) are valid text; `.` alone would not match a
        // trailing CR, so use [\s\S] and strip one display CR.
        const m = body.match(/^(\d+):([\s\S]*)$/)
        if (!m) {
          malformed += 1
          continue
        }
        const rawText = m[2].endsWith('\r') ? m[2].slice(0, -1) : m[2]
        let text = rawText
        if (text.length > MAX_GREP_LINE_CHARS) {
          let cut = MAX_GREP_LINE_CHARS
          const last = text.charCodeAt(cut - 1)
          // Do not split a surrogate pair at the shortening boundary.
          if (last >= 0xd800 && last <= 0xdbff) cut -= 1
          text = `${text.slice(0, cut)}...[line truncated]`
        }
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
