import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GLOB_PY, makeGlobTool, makeGrepTool } from '../src/tools/search.js'
import { installFakeSsh, installLocalSsh, remoteCommand } from './helpers.mjs'

const target = { ssh: 'h', name: 'h', controlPersist: 0 }
const exec = { signal: new AbortController().signal }

// GLOB_PY runs under the remote host's python3; running it under the local
// python3 against a fixture dir exercises the same interpreter and semantics.
test('glob translate: [!...] negation, depth anchoring, exact end anchor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-'))
  try {
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'a.ts'), '')
    await writeFile(join(dir, 'b.log'), '')
    await writeFile(join(dir, 'sub', 'c.ts'), '')
    await writeFile(join(dir, 'a\nb.txt'), '')
    await mkdir(join(dir, 'x\ny'))
    await writeFile(join(dir, 'x\ny', 'c.txt'), '')
    await writeFile(join(dir, 'foo\n'), '') // a trailing newline must not let "foo" match
    // Paths are NUL-delimited; the total marker follows the last NUL.
    const run = (pattern) => {
      const parts = execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '100'], { encoding: 'utf8' }).split('\0')
      parts.pop() // total marker
      return parts.filter(Boolean).sort()
    }
    assert.deepEqual(run('[!a]*.ts'), [join(dir, 'sub', 'c.ts')]) // a.ts excluded by [!a]
    assert.deepEqual(run('*.ts'), [join(dir, 'a.ts'), join(dir, 'sub', 'c.ts')].sort())
    assert.deepEqual(run('sub/*.ts'), [join(dir, 'sub', 'c.ts')])
    // `**` must cross newlines inside path components, like `*` does.
    assert.deepEqual(run('**/*.txt'), [join(dir, 'a\nb.txt'), join(dir, 'x\ny', 'c.txt')].sort())
    assert.deepEqual(run('foo'), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob keeps the newest top-k entries, exact total and stable equal-mtime order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-heap-'))
  try {
    for (let i = 0; i < 350; i++) {
      const file = join(dir, `${i}.txt`)
      await writeFile(file, '')
      const time = 1700000000 + Math.floor(i / 3)
      await utimes(file, time, time)
    }
    const run = cap => {
      const parts = execFileSync('python3', ['-c', GLOB_PY, '*.txt', dir, String(cap)], { encoding: 'utf8' }).split('\0')
      const marker = (parts.pop() ?? '').trim()
      return { paths: parts.filter(Boolean), marker }
    }
    const all = run(1000)
    const capped = run(100)
    assert.equal(capped.marker, '__REMOTE_SSH_TOTAL__350')
    assert.equal(all.marker, '__REMOTE_SSH_TOTAL__350')
    assert.deepEqual(capped.paths, all.paths.slice(0, 100))
    assert.ok(capped.paths[0].endsWith('348.txt') || capped.paths[0].endsWith('349.txt'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep refuses a transport-truncated structured result', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_BIG = String(5 * 1024 * 1024)
  process.env.FAKE_SSH_MARK = '0'
  try {
    await assert.rejects(makeGrepTool(target, '/remote').execute({ pattern: 'x' }, exec), /output exceeded the transport\/decoded limit/)
  } finally {
    delete process.env.FAKE_SSH_BIG
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('grep rejects decoded-only truncation instead of misparsing records', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-decoded-'))
  const previous = process.env.LC_ALL
  process.env.LC_ALL = 'C'
  try {
    await writeFile(join(dir, 'weird.txt'), Buffer.concat([Buffer.from('hit'), Buffer.alloc(1_400_000, 0xff)]))
    await writeFile(join(dir, 'small.txt'), 'hit\n')
    await assert.rejects(makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: 'hit' }, exec), /transport\/decoded limit/)
  } finally {
    if (previous === undefined) delete process.env.LC_ALL
    else process.env.LC_ALL = previous
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep groups matches under filenames containing ":" and digits', async () => {
  const fake = await installFakeSsh()
  const grep = makeGrepTool(target, '/remote', (p) => p)
  process.env.FAKE_SSH_STDOUT = 'dir/a:1/b.txt__NUL__5:hit\ndir/plain.txt__NUL__2:hit2\n'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await grep.execute({ pattern: 'hit' }, exec)
    const calls = await fake.readLog()
    assert.match(remoteCommand(calls.at(-1)), /--null/, 'grep separates filenames with NUL')
    assert.match(out, /dir\/a:1\/b\.txt\n5:hit/, out)
    assert.match(out, /dir\/plain\.txt\n2:hit2/, out)
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('grep keeps a filename containing a newline as one record', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_STDOUT = 'dir/foo\nbar.txt__NUL__5:hit\n'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await makeGrepTool(target, '/remote').execute({ pattern: 'hit' }, exec)
    assert.match(out, /dir\/foo\nbar\.txt\n5:hit/, out)
    assert.ok(!out.startsWith('bar.txt\n5:hit'), 'the suffix of a newline filename must not become a file')
    assert.ok(!out.includes('\n\nbar.txt\n5:hit'), 'no bogus separate group for the filename suffix')
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('grep with >250 newline-named matches reports the cap instead of silently truncating', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-newline-'))
  try {
    for (let i = 0; i < 300; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, '0')}\nname.txt`), 'hit\n')
    }
    const out = await makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: 'hit' }, exec)
    assert.match(out, /truncated at 250 matches/)
    assert.equal(out.split('\n').filter(line => line === '1:hit').length, 250)
  } finally {
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob keeps older representable paths when newer names are not UTF-8', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-utf8-'))
  try {
    for (let i = 0; i < 100; i++) {
      const path = Buffer.concat([
        Buffer.from(join(dir, `bad${String(i).padStart(3, '0')}-`)),
        Buffer.from([0xff]),
        Buffer.from('.txt'),
      ])
      await writeFile(path, '')
      const time = 1700001000 + i
      await utimes(path, time, time)
    }
    await writeFile(join(dir, 'older-valid.txt'), '')
    await utimes(join(dir, 'older-valid.txt'), 1700000000, 1700000000)
    const out = execFileSync('python3', ['-c', GLOB_PY, '*.txt', dir, '100'], { encoding: 'utf8' })
    const parts = out.split('\0')
    assert.equal((parts.pop() ?? '').trim(), '__REMOTE_SSH_TOTAL__101')
    assert.deepEqual(parts.filter(Boolean), [join(dir, 'older-valid.txt')])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep line shortening does not split a surrogate pair', async () => {
  const fake = await installFakeSsh()
  const line = 'a'.repeat(8191) + '😀' + 'tail'
  process.env.FAKE_SSH_STDOUT = `dir/f.txt__NUL__1:${line}\n`
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await makeGrepTool(target, '/remote').execute({ pattern: 'x' }, exec)
    assert.match(out, /\[line truncated\]/)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), 'no lone high surrogate at the cut')
    assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), 'no lone low surrogate at the cut')
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('grep keeps matches whose lines end with CR (CRLF files)', async () => {
  const fake = await installFakeSsh()
  process.env.FAKE_SSH_STDOUT = 'dir/crlf.txt__NUL__1:hit\r\ndir/crlf.txt__NUL__3:hit\r\n'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await makeGrepTool(target, '/remote').execute({ pattern: 'hit' }, exec)
    assert.match(out, /dir\/crlf\.txt\n1:hit\n3:hit/)
    assert.doesNotMatch(out, /skipped/)
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('grep reports an unusable head instead of no matches', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-head-'))
  const shim = await mkdtemp(join(tmpdir(), 'remote-ssh-head-shim-'))
  await writeFile(join(dir, 'f.txt'), 'hit\n')
  await writeFile(join(shim, 'head'), '#!/bin/sh\necho "head: invalid option -- z" >&2\nexit 1\n', { mode: 0o755 })
  const previous = process.env.PATH
  process.env.PATH = `${shim}:${previous}`
  try {
    await assert.rejects(
      makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir).execute({ pattern: 'hit' }, exec),
      /head -z failed/,
    )
  } finally {
    process.env.PATH = previous
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
    await rm(shim, { recursive: true, force: true })
  }
})

test('glob reports missing, non-directory, and unreadable paths distinctly', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-err-'))
  const locked = join(dir, 'locked')
  const unreadable = join(dir, 'unreadable')
  const nonRoot = typeof process.getuid === 'function' ? process.getuid() !== 0 : true
  try {
    const glob = () => makeGlobTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
    await assert.rejects(glob().execute({ pattern: '*.txt', path: join(dir, 'missing') }, exec), /no such directory/)
    await writeFile(join(dir, 'file.txt'), '')
    await assert.rejects(glob().execute({ pattern: '*.txt', path: join(dir, 'file.txt') }, exec), /not a directory/)
    // An intermediate component that is a file is a non-directory root.
    await assert.rejects(glob().execute({ pattern: '*.txt', path: join(join(dir, 'file.txt'), 'x') }, exec), /not a directory/)
    if (nonRoot) {
      await mkdir(locked)
      await chmod(locked, 0)
      await assert.rejects(glob().execute({ pattern: '*.txt' }, exec), (error) => {
        assert.match(error.message, /Permission denied/)
        assert.doesNotMatch(error.message, /Traceback/)
        return true
      })
      // A root reachable only through an unsearchable parent is a permission
      // error, not "no such directory".
      await mkdir(join(unreadable, 'inner'), { recursive: true })
      await chmod(unreadable, 0)
      await assert.rejects(glob().execute({ pattern: '*.txt', path: join(unreadable, 'inner') }, exec), /permission denied/)
    }
  } finally {
    await chmod(locked, 0o755).catch(() => {})
    await chmod(unreadable, 0o755).catch(() => {})
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep classifies non-regular and inaccessible roots without blocking', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-root-'))
  const fifo = join(dir, 'pipe')
  const locked = join(dir, 'locked')
  spawnSync('mkfifo', [fifo])
  const nonRoot = typeof process.getuid === 'function' ? process.getuid() !== 0 : true
  try {
    const grep = () => makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
    const started = Date.now()
    await assert.rejects(grep().execute({ pattern: 'hit', path: fifo }, exec), /not a regular file or directory/)
    assert.ok(Date.now() - started < 3000, 'a FIFO root is rejected instead of blocking until the SSH timeout')
    await assert.rejects(grep().execute({ pattern: 'hit', path: join(dir, 'missing') }, exec), /no such path or not accessible/)
    if (nonRoot) {
      await mkdir(join(locked, 'inner'), { recursive: true })
      await chmod(locked, 0)
      await assert.rejects(grep().execute({ pattern: 'hit', path: join(locked, 'inner') }, exec), /not accessible/)
    }
  } finally {
    await chmod(locked, 0o755).catch(() => {})
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob rejects patterns with too many ambiguous wildcards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-complex-'))
  try {
    // The documented boundary is accepted: one ** plus four other stars.
    for (const pattern of ['**/*src*/*helper*.py', '[?][?][?][?][?]']) {
      const parts = execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '10'], { encoding: 'utf8' }).split('\0')
      assert.equal((parts.pop() ?? '').trim(), '__REMOTE_SSH_TOTAL__0')
    }
    for (const pattern of ['**/'.repeat(2) + 'x', '*a'.repeat(5) + 'b', '{*,*}'.repeat(3) + 'x']) {
      let failure
      try {
        execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '10'], { encoding: 'utf8' })
      } catch (error) {
        failure = error
      }
      assert.ok(failure, pattern)
      assert.match(String(failure.stderr), /__REMOTE_SSH_ERR__:too-complex/)
      assert.doesNotMatch(String(failure.stderr), /Traceback/)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob cap header does not blame non-UTF-8 names for the item cap', async () => {
  const fake = await installFakeSsh()
  // The helper expands __NUL__; environment values cannot carry a raw NUL.
  process.env.FAKE_SSH_STDOUT = Array.from({ length: 100 }, (_, i) => `/remote/f${i}__NUL__`).join('')
    + '__REMOTE_SSH_TOTAL__350\n'
  process.env.FAKE_SSH_MARK = '0'
  try {
    const out = await makeGlobTool(target, '/remote').execute({ pattern: '*.txt' }, exec)
    assert.match(out, /^Showing 100 of 350 matches \(newest first; non-UTF-8 names are not listed\)\./)
    assert.doesNotMatch(out, /non-UTF-8 names are skipped/)
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
  }
})

test('glob does not mistake an error path for a sentinel line', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-sentinel-'))
  const locked = join(dir, '__REMOTE_SSH_ERR__:bad-pattern')
  try {
    await mkdir(locked)
    await chmod(locked, 0)
    await assert.rejects(makeGlobTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir).execute({ pattern: '*.txt' }, exec), (error) => {
      assert.match(error.message, /Permission denied/)
      assert.doesNotMatch(error.message, /invalid pattern/)
      return true
    })
  } finally {
    await chmod(locked, 0o755).catch(() => {})
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob backslash escapes the next character and is not counted by the budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-escape-'))
  try {
    await writeFile(join(dir, '*a'), '')
    await writeFile(join(dir, 'za'), '')
    const run = (pattern) => {
      const parts = execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '10'], { encoding: 'utf8' }).split('\0')
      parts.pop()
      return parts.filter(Boolean).sort()
    }
    assert.deepEqual(run('\\*a'), [join(dir, '*a')])
    // Six escaped wildcards are literals; this must neither be rejected nor
    // backtrack exponentially.
    const started = Date.now()
    assert.deepEqual(run('\\*a'.repeat(6)), [])
    assert.ok(Date.now() - started < 2000)

    for (const name of ['a,b', 'a}', 'b', '{a{b{c']) await writeFile(join(dir, name), '')
    assert.deepEqual(run('{a\\,b}'), [join(dir, 'a,b')])
    assert.deepEqual(run('{a\\},b}'), [join(dir, 'a}'), join(dir, 'b')].sort())
    // Unmatched braces are literals, not alternations.
    assert.deepEqual(run('{a{b{c'), [join(dir, '{a{b{c')])
    let nested
    try {
      execFileSync('python3', ['-c', GLOB_PY, '{{a,b}}', dir, '10'], { encoding: 'utf8' })
    } catch (error) {
      nested = error
    }
    assert.ok(nested)
    assert.match(String(nested.stderr), /__REMOTE_SSH_ERR__:bad-pattern/)
    assert.doesNotMatch(String(nested.stderr), /Traceback/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep skips binary files instead of reporting them as parseable', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-binary-'))
  try {
    await writeFile(join(dir, 'bin.dat'), Buffer.from('hit\0more'))
    const grep = makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
    const out = await grep.execute({ pattern: 'hit' }, exec)
    assert.match(out, /No parseable matches/)
    assert.doesNotMatch(out, /binary file matches/)
    assert.doesNotMatch(out, /record\(s\) skipped/)
    const calls = await ssh.readLog()
    // -rHInE already includes -I (skip binary files).
    assert.match(remoteCommand(calls.at(-1)), /grep -rHInE -D skip/)
  } finally {
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob handles many unmatched braces without quadratic scanning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-braces-'))
  try {
    const started = Date.now()
    const out = execFileSync('python3', ['-c', GLOB_PY, '{'.repeat(10000), dir, '10'], { encoding: 'utf8' })
    assert.match(out, /__REMOTE_SSH_TOTAL__0/)
    assert.ok(Date.now() - started < 2000, `unmatched braces stay linear (${Date.now() - started}ms)`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob handles many unclosed brackets without quadratic scanning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-brackets-'))
  try {
    const started = Date.now()
    const out = execFileSync('python3', ['-c', GLOB_PY, '['.repeat(10000), dir, '10'], { encoding: 'utf8' })
    assert.match(out, /__REMOTE_SSH_TOTAL__0/)
    assert.ok(Date.now() - started < 2000, `unclosed classes stay linear (${Date.now() - started}ms)`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('glob bracket classes handle a literal ] and reject invalid ranges cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-class-'))
  try {
    const names = ['].txt', '^.txt', '_.txt', '`.txt', '\\.txt', 'a.txt', 'b.txt', 'c.txt', 'y.txt', 'z.txt', '-.txt']
    for (const name of names) await writeFile(join(dir, name), '')
    await mkdir(join(dir, 'top', 'sub'), { recursive: true })
    await writeFile(join(dir, 'top', 'sub', 'x'), '')
    for (const top of ['top0sub', 'top-sub', 'top.sub', 'topAsub', 'top:sub']) {
      await mkdir(join(dir, top), { recursive: true })
      await writeFile(join(dir, top, 'x'), '')
    }
    const at = (...list) => list.map(name => join(dir, name)).sort()
    const run = (pattern) => {
      const parts = execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '100'], { encoding: 'utf8' }).split('\0')
      parts.pop()
      return parts.filter(Boolean).sort()
    }
    assert.deepEqual(run('[]].txt'), at('].txt'))
    assert.deepEqual(run('[!]].txt'), at('a.txt', 'b.txt', 'c.txt', 'y.txt', 'z.txt', '-.txt', '^.txt', '_.txt', '`.txt', '\\.txt'))
    // A backslash-escaped '-' is a literal member, not a range endpoint.
    assert.deepEqual(run('[a\\-z].txt'), at('-.txt', 'a.txt', 'z.txt'))
    // ... and a backslash-escaped ']' does not close the class.
    assert.deepEqual(run('[a\\]].txt'), at('].txt', 'a.txt'))
    // Class-special characters remain valid range endpoints.
    assert.deepEqual(run('[]-a].txt'), at('].txt', '^.txt', '_.txt', '`.txt', 'a.txt'))
    assert.deepEqual(run('[!]-a].txt'), at('-.txt', 'b.txt', 'c.txt', 'y.txt', 'z.txt', '\\.txt'))
    assert.deepEqual(run('[--c].txt'), at('-.txt', '].txt', '^.txt', '_.txt', '`.txt', 'a.txt', 'b.txt', 'c.txt', '\\.txt'))
    assert.deepEqual(run('[\\\\-a].txt'), at('].txt', '^.txt', '_.txt', '`.txt', 'a.txt', '\\.txt'))
    assert.deepEqual(run('[\\^-z].txt'), at('^.txt', '_.txt', '`.txt', 'a.txt', 'b.txt', 'c.txt', 'y.txt', 'z.txt'))
    // Bracket classes never consume a path separator, including a non-negated
    // range whose interval contains '/'.
    assert.deepEqual(run('top[!a]sub/x'), at('top0sub/x', 'top-sub/x', 'top.sub/x', 'topAsub/x', 'top:sub/x'))
    assert.deepEqual(run('top[!0]sub/x'), at('top-sub/x', 'top.sub/x', 'topAsub/x', 'top:sub/x'))
    assert.deepEqual(run('top[/]sub/x'), [])
    assert.deepEqual(run('top[.-0]sub/x'), at('top0sub/x', 'top.sub/x'))
    // An interval with '/' as an endpoint is narrowed to the surviving part.
    assert.deepEqual(run('top[/-a]sub/x'), at('top0sub/x', 'topAsub/x', 'top:sub/x'))
    assert.deepEqual(run('top[!/-0]sub/x'), at('top-sub/x', 'top.sub/x', 'topAsub/x', 'top:sub/x'))
    assert.deepEqual(run('top[--/]sub/x'), at('top-sub/x', 'top.sub/x'))
    let failure
    try {
      execFileSync('python3', ['-c', GLOB_PY, '[z-a]', dir, '100'], { encoding: 'utf8' })
    } catch (error) {
      failure = error
    }
    assert.ok(failure, 'an invalid range must fail')
    assert.match(String(failure.stderr), /__REMOTE_SSH_ERR__:bad-pattern/)
    assert.doesNotMatch(String(failure.stderr), /Traceback/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep at exactly the match cap reports no truncation', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-exact-'))
  try {
    await writeFile(join(dir, 'many.txt'), 'hit\n'.repeat(250))
    const out = await makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: 'hit' }, exec)
    assert.doesNotMatch(out, /truncated/)
    assert.equal(out.split('\n').filter(line => /^\d+:hit$/.test(line)).length, 250)
  } finally {
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep at one over the match cap reports truncation', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-over-'))
  try {
    await writeFile(join(dir, 'many.txt'), 'hit\n'.repeat(251))
    const out = await makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: 'hit' }, exec)
    assert.match(out, /truncated at 250 matches/)
    assert.equal(out.split('\n').filter(line => /^\d+:hit$/.test(line)).length, 250)
  } finally {
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep caps encoded output at 512 KiB', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-bytes-'))
  try {
    const line = 'x'.repeat(8192) + 'hit'
    await writeFile(join(dir, 'long.txt'), `${line}\n`.repeat(70))
    const out = await makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: 'hit' }, exec)
    assert.match(out, /\[output truncated at 512 KiB/)
    const bytes = Buffer.byteLength(out)
    assert.ok(bytes <= 600 * 1024, `bounded output (${bytes} bytes)`)
    assert.ok(bytes >= 480 * 1024, `the cap is not silently tiny (${bytes} bytes)`)
    const matches = out.split('\n').filter(line => /^\d+:x/.test(line)).length
    assert.ok(matches >= 60, `complete records are kept (${matches})`)
  } finally {
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep counts a long filename once against the output cap', async () => {
  const ssh = await installLocalSsh()
  const base = await mkdtemp(join(tmpdir(), 'remote-ssh-grep-longpath-'))
  let dir = base
  try {
    for (let i = 0; i < 12; i++) {
      dir = join(dir, `d${i}-${'x'.repeat(240)}`)
      await mkdir(dir)
    }
    await writeFile(join(dir, 'many.txt'), 'hit\n'.repeat(250))
    const out = await makeGrepTool({ ssh: 'h', name: 'h', controlPersist: 0 }, base)
      .execute({ pattern: 'hit' }, exec)
    assert.equal(out.split('\n').filter(line => /^\d+:hit$/.test(line)).length, 250)
    assert.doesNotMatch(out, /output truncated at 512 KiB/)
  } finally {
    await ssh.cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test('glob uses UTF-8 filenames regardless of the remote locale', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-locale-'))
  const previous = {
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
    PYTHONUTF8: process.env.PYTHONUTF8,
    PYTHONCOERCECLOCALE: process.env.PYTHONCOERCECLOCALE,
  }
  try {
    await writeFile(join(dir, 'valid-é.txt'), '')
    process.env.LC_ALL = 'C'
    process.env.LANG = 'C'
    process.env.PYTHONUTF8 = '0'
    process.env.PYTHONCOERCECLOCALE = '0'
    const out = await makeGlobTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: '*.txt' }, exec)
    assert.match(out, /valid-é\.txt/)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the glob helper ignores PYTHONPATH module shadowing', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-shadow-'))
  const shadow = join(dir, 'shadow')
  await mkdir(shadow)
  await writeFile(join(shadow, 'heapq.py'), 'raise RuntimeError("shadowed stdlib heapq")\n')
  const previous = process.env.PYTHONPATH
  process.env.PYTHONPATH = shadow
  try {
    await writeFile(join(dir, 'ok.txt'), '')
    const out = await makeGlobTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
      .execute({ pattern: '*.txt' }, exec)
    assert.match(out, /ok\.txt/)
  } finally {
    if (previous === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = previous
    await ssh.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
