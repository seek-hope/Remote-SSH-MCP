import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeReadTool, makeWriteTool, makeEditTool } from '../src/tools/files.js'
import { installLocalSsh, installFakeSsh } from './helpers.mjs'

const MiB = 1024 * 1024
async function fixture(run) {
  const fake = await installLocalSsh()
  const target = { ssh: 'offline', name: 'fixture', root: fake.dir, controlPersist: 0 }
  try {
    await run({ fake, dir: fake.dir, read: makeReadTool(target), write: makeWriteTool(target), edit: makeEditTool(target) })
  } finally {
    await fake.cleanup()
  }
}

test('read preserves newlines, empty files, blank lines, BOM and Unicode', async () => fixture(async ({ dir, read }) => {
  const file = join(dir, 'text')
  for (const [content, total] of [['', 0], ['alpha\nbeta', 2], ['alpha\nbeta\n', 2], ['\n\n', 2], ['\uFEFF中文\n😀 �\n', 2]]) {
    await writeFile(file, content)
    const out = await read.execute({ file_path: file }, {})
    assert.match(out, total === 0 ? /File is empty/ : new RegExp(`End of file - total ${total} lines`))
    const lines = content ? content.replace(/\n$/, '').split('\n') : []
    for (let i = 0; i < lines.length; i++) assert.ok(out.includes(`${i + 1}\t${lines[i]}`), out)
    assert.ok(!out.includes(`${total + 1}\t`), 'no phantom line')
  }
}))

test('read validates the requested UTF-8 window instead of silently replacing invalid bytes', async () => fixture(async ({ dir, read }) => {
  const file = join(dir, 'text')
  for (const content of [Buffer.from([0x61, 0xff, 0x62]), Buffer.from('a\0b')]) {
    await writeFile(file, content)
    await assert.rejects(read.execute({ file_path: file }, {}), /UTF-8/)
  }
  await assert.rejects(read.execute({ file_path: dir }, {}), /directory/)
  await assert.rejects(read.execute({ file_path: join(dir, 'absent') }, {}), /No such file/)
}))

test('read caps complete lines at the source and resumes without wrong numbering or skipped bytes', async () => fixture(async ({ dir, read }) => {
  const file = join(dir, 'large')
  const lines = Array.from({ length: 1500 }, (_, i) => `ACTUAL_LINE_${i + 1}|${'x'.repeat(3980)}`)
  await writeFile(file, lines.join('\n') + '\n')
  let offset = 1
  let calls = 0
  while (offset <= lines.length) {
    const out = await read.execute({ file_path: file, offset, limit: 1500 }, {})
    assert.match(out, /total 1500 lines|of 1500/)
    const shown = out.split('\n').filter(line => /^\d+\t/.test(line))
    assert.ok(shown.length > 0)
    for (let i = 0; i < shown.length; i++) assert.equal(shown[i], `${offset + i}\t${lines[offset + i - 1]}`)
    offset += shown.length
    if (offset <= lines.length) {
      assert.match(out, /truncated/)
      assert.ok(out.includes(`offset=${offset}`))
    } else assert.match(out, /End of file/)
    calls++
  }
  assert.ok(calls > 1)
  assert.equal((await read.execute({ file_path: file, offset: 2000 }, {})).includes('past end of file - total 1500'), true)
}))

test('read handles chunk boundaries and rejects an oversized individual line', async () => fixture(async ({ dir, read }) => {
  const file = join(dir, 'text')
  const prefix = 'a'.repeat(65535) + '\n'
  await writeFile(file, prefix + '中文\nlast')
  const out = await read.execute({ file_path: file, offset: 2, limit: 1 }, {})
  assert.match(out, /2\t中文/)
  assert.match(out, /Showing lines 2-2 of 3/)
  await writeFile(file, 'x'.repeat(MiB + 1))
  await assert.rejects(read.execute({ file_path: file }, {}), /line 1 exceeds/)
  await assert.rejects(read.execute({ file_path: file, limit: 2001 }, {}), /limit/)
  await assert.rejects(read.execute({ file_path: file, offset: Number.MAX_SAFE_INTEGER + 1 }, {}), /safe integer/)
}))

test('write verifies raw stdin, preserves permissions, and creates private files without temp leftovers', async () => fixture(async ({ dir, write }) => {
  const file = join(dir, "quote'$(touch INJECTED).txt")
  for (const content of ['', 'hello 中文 😀\n', 'x'.repeat(MiB)]) {
    await write.execute({ file_path: file, content }, {})
    assert.equal(await readFile(file, 'utf8'), content)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  await chmod(file, 0o640)
  await write.execute({ file_path: file, content: 'new' }, {})
  assert.equal((await stat(file)).mode & 0o777, 0o640)
  assert.ok(!(await readdir(dir)).some(name => name.startsWith('.remote-ssh-tmp-') || name === 'INJECTED'))
}))

test('early EOF, extra bytes and equal-length corruption never replace an existing file', async () => {
  const fake = await installFakeSsh()
  const path = join(fake.dir, 'destination')
  const target = { ssh: 'offline', name: 'fixture', root: fake.dir, controlPersist: 0 }
  process.env.FAKE_SSH_STDOUT = '{"bytes":12}'
  try {
    await writeFile(path, 'ORIGINAL', { mode: 0o640 })
    await makeWriteTool(target).execute({ file_path: path, content: 'ABCDEFGHIJKL' }, {})
    const args = (await fake.readLog()).at(-1)
    for (const input of ['ABC', '', 'ABCDEFGHIJKLM', 'XXXXXXXXXXXX']) {
      const result = spawnSync('sh', ['-c', args.at(-1)], { input, encoding: 'utf8', timeout: 5000 })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /integrity check failed/)
      assert.equal(await readFile(path, 'utf8'), 'ORIGINAL')
      assert.equal((await stat(path)).mode & 0o777, 0o640)
      assert.ok(!(await readdir(fake.dir)).some(name => name.startsWith('.remote-ssh-tmp-')))
    }
  } finally {
    delete process.env.FAKE_SSH_STDOUT
    await fake.cleanup()
  }
})

test('edit runs in one SSH call and rejects missing, ambiguous and oversized replacements', async () => fixture(async ({ dir, edit, fake }) => {
  const file = join(dir, 'text')
  await writeFile(file, 'old old')
  await assert.rejects(edit.execute({ file_path: file, old_string: 'old', new_string: 'new' }, {}), /appears 2 times/)
  await assert.rejects(edit.execute({ file_path: file, old_string: 'absent', new_string: 'new' }, {}), /not found/)
  const before = (await fake.readLog()).length
  await edit.execute({ file_path: file, old_string: 'old', new_string: '$& 中文', replace_all: true }, {})
  assert.equal((await fake.readLog()).length, before + 1)
  assert.equal(await readFile(file, 'utf8'), '$& 中文 $& 中文')
  await writeFile(file, 'x'.repeat(4 * MiB + 1))
  await assert.rejects(edit.execute({ file_path: file, old_string: 'x', new_string: '' }, {}), /exceeds/)
  await writeFile(file, 'x'.repeat(4 * MiB))
  await assert.rejects(edit.execute({ file_path: file, old_string: 'x', new_string: 'xx', replace_all: true }, {}), /edited result exceeds/)
  assert.equal((await stat(file)).size, 4 * MiB)
}))
