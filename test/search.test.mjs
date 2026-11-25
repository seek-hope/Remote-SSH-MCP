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
    await assert.rejects(makeGrepTool(target, '/remote').execute({ pattern: 'x' }, exec), /output exceeded the transport limit/)
  } finally {
    delete process.env.FAKE_SSH_BIG
    delete process.env.FAKE_SSH_MARK
    await fake.cleanup()
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

test('glob bracket classes handle a literal ] and reject invalid ranges cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-class-'))
  try {
    await writeFile(join(dir, '].txt'), '')
    await writeFile(join(dir, 'a.txt'), '')
    const run = (pattern) => {
      const parts = execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '100'], { encoding: 'utf8' }).split('\0')
      parts.pop()
      return parts.filter(Boolean).sort()
    }
    assert.deepEqual(run('[]].txt'), [join(dir, '].txt')])
    assert.deepEqual(run('[!]].txt'), [join(dir, 'a.txt')])
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
