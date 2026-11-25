import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

test('glob reports missing and unreadable paths instead of no matches', async () => {
  const ssh = await installLocalSsh()
  const dir = await mkdtemp(join(tmpdir(), 'remote-ssh-glob-err-'))
  const locked = join(dir, 'locked')
  try {
    const glob = () => makeGlobTool({ ssh: 'h', name: 'h', controlPersist: 0 }, dir)
    await assert.rejects(glob().execute({ pattern: '*.txt', path: join(dir, 'missing') }, exec), /no such directory/)
    await writeFile(join(dir, 'file.txt'), '')
    await assert.rejects(glob().execute({ pattern: '*.txt', path: join(dir, 'file.txt') }, exec), /no such directory/)
    await mkdir(locked)
    await chmod(locked, 0)
    await assert.rejects(glob().execute({ pattern: '*.txt' }, exec), /Permission denied|glob:/)
  } finally {
    await chmod(locked, 0o755).catch(() => {})
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
