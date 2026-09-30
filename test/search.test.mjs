import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GLOB_PY, makeGrepTool } from '../src/tools/search.js'
import { installFakeSsh, remoteCommand } from './helpers.mjs'

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
    const run = (pattern) => execFileSync('python3', ['-c', GLOB_PY, pattern, dir, '100'], { encoding: 'utf8' })
      .split('\n').filter(l => l && !l.startsWith('__REMOTE_SSH_TOTAL__')).sort()
    assert.deepEqual(run('[!a]*.ts'), [join(dir, 'sub', 'c.ts')]) // a.ts excluded by [!a]
    assert.deepEqual(run('*.ts'), [join(dir, 'a.ts'), join(dir, 'sub', 'c.ts')].sort())
    assert.deepEqual(run('sub/*.ts'), [join(dir, 'sub', 'c.ts')])
    assert.deepEqual(run('foo'), [])
  } finally {
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
