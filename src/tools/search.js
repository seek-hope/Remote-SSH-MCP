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

/**
 * Python 3.9-compatible glob walker. Reads pattern and root from argv,
 * prints matching absolute paths (mtime desc, capped) then a total marker.
 * `**` crosses directories, `*`/`?` stay within one path segment,
 * `{a,b}` alternation supported. .git/.svn/.hg are skipped.
 */
const GLOB_PY = String.raw`
import os, re, sys

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
                out.append(pat[i:j + 1]); i = j + 1
        else:
            out.append(re.escape(c)); i += 1
    return ''.join(out)

rx = re.compile('^' + translate(pattern) + '$')
basename_mode = '/' not in pattern
results = []
skipped_dirs = {'.git', '.svn', '.hg', 'node_modules'}
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in skipped_dirs]
    for name in filenames:
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root)
        subject = name if basename_mode else rel
        if rx.match(subject):
            try:
                results.append((os.path.getmtime(full), full))
            except OSError:
                results.append((0.0, full))
results.sort(key=lambda t: -t[0])
total = len(results)
for _, p in results[:cap]:
    print(p)
print('__REMOTE_SSH_TOTAL__%d' % total)
`.trim()

export function makeGlobTool(target, cwd, toRemote) {
  return defTextTool({
    name: 'glob',
    description: `Find files whose paths match a glob pattern. Returns matching file paths — never directories — in modification-time order, up to ${GLOB_CAP} paths. REMOTE: the search runs on ${target.name} (ssh ${target.ssh}); .git/node_modules directories are skipped.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match file paths against (e.g. "**/*.ts"). A pattern with no "/" matches the basename at any depth; include a separator to anchor the depth.' },
        path: { type: 'string', description: `Directory to search in, on the remote host ${target.name}. Defaults to the target root; a relative path resolves against it.` },
      },
      required: ['pattern'],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const a = checkArgs('glob', args, { pattern: 'string', path: '?string' })
      const root = toRemote(resolveRemote(a.path ?? '.', cwd))
      const r = await sshRun({
        target: target.ssh, port: target.port,
        controlPersist: target.controlPersist,
        command: `test -d ${shq(root)} && python3 -c ${shq(GLOB_PY)} ${shq(a.pattern)} ${shq(root)} ${GLOB_CAP}`,
        signal: exec.signal,
      })
      if (r.code !== 0) throw new Error(`glob: search failed on ${target.name}: ${r.stderr.trim() || r.stdout.slice(-120)}`)
      const lines = r.stdout.trimEnd().split('\n')
      const marker = lines.pop() || ''
      if (!marker.startsWith('__REMOTE_SSH_TOTAL__')) throw new Error(`glob: unexpected remote output (no total marker)`)
      const total = parseInt(marker.slice('__REMOTE_SSH_TOTAL__'.length), 10)
      const paths = lines.filter(Boolean)
      if (paths.length === 0) return `No files matched "${a.pattern}" under ${root} (remote host ${target.name}).`
      const header = Number.isFinite(total) && total > paths.length
        ? `Showing ${paths.length} of ${total} matches (mtime order, capped).`
        : `${paths.length} match${paths.length === 1 ? '' : 'es'}.`
      return `${header}\n${paths.join('\n')}`
    },
  })
}

export function makeGrepTool(target, cwd, toRemote) {
  return defTextTool({
    name: 'grep',
    description: `Search file contents with a regular expression (POSIX ERE on the remote grep; ripgrep-only syntax like \\p{...} is unsupported). Returns matching lines with line numbers, grouped by file, capped at ${GREP_CAP} matches. REMOTE: the search runs on ${target.name} (ssh ${target.ssh}); binary files and .git are skipped.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (extended regex).' },
        path: { type: 'string', description: `File or directory to search, on the remote host ${target.name}. Defaults to the target root; a relative path resolves against it.` },
        include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts"). Not a list; negation is not supported.' },
      },
      required: ['pattern'],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const a = checkArgs('grep', args, { pattern: 'string', path: '?string', include: '?string' })
      const root = toRemote(resolveRemote(a.path ?? '.', cwd))
      const include = a.include ? ` --include=${shq(a.include)}` : ''
      // Keep grep errors distinct from no matches; SIGPIPE is expected at the cap.
      const search = `grep -rHInE${include} --exclude-dir=.git --exclude-dir=node_modules -e ${shq(a.pattern)} -- ${shq(root)} | head -n ${GREP_CAP + 1}; rc=\${PIPESTATUS[0]}; [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || [ "$rc" -eq 141 ]`
      const script = [
        `if [ ! -e ${shq(root)} ]; then echo "__REMOTE_SSH_ERR__:no-such-path"`,
        `else bash -c ${shq(search)}; fi`,
      ].join('\n')
      const r = await sshRun({ target: target.ssh, port: target.port, command: script, signal: exec.signal, controlPersist: target.controlPersist })
      if (r.code !== 0) throw new Error(`grep: search failed on ${target.name}: ${r.stderr.trim() || 'remote command did not complete'}`)
      const raw = r.stdout
      if (raw.startsWith('__REMOTE_SSH_ERR__:no-such-path')) throw new Error(`grep: no such path on ${target.name}: ${root}`)
      const lines = raw.split('\n').filter(Boolean)
      const truncated = lines.length > GREP_CAP
      const shown = truncated ? lines.slice(0, GREP_CAP) : lines
      if (shown.length === 0) return `No matches for /${a.pattern}/ under ${root} (remote host ${target.name}).`
      // group path:line:text by file, preserving order
      const groups = new Map()
      for (const line of shown) {
        const m = line.match(/^(.*?):(\d+):(.*)$/)
        if (!m) continue
        const [, file, lineNo, text] = m
        if (!groups.has(file)) groups.set(file, [])
        groups.get(file).push(`${lineNo}:${text}`)
      }
      const body = [...groups.entries()].map(([f, ls]) => `${f}\n${ls.join('\n')}`).join('\n\n')
      const note = truncated ? `\n[truncated at ${GREP_CAP} matches; narrow the pattern or path]` : ''
      return `${body}${note}`
    },
  })
}
