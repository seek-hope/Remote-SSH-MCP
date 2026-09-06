import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEditTool, makeWriteTool } from '../src/tools/files.js'

// Execute the generated remote shell locally, confined to a temporary fixture.
// No SSH server or network connection is involved.
async function withLocalSsh(run) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-file-integration-'))
  const originalPath = process.env.PATH
  const bin = join(dir, 'ssh')
  await writeFile(bin, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const command = process.argv.at(-1)
if (command.startsWith('if base64') && process.env.REMOTE_SSH_TEST_CONFLICT_FILE) {
  writeFileSync(process.env.REMOTE_SSH_TEST_CONFLICT_FILE, 'concurrent edit with a different size')
}
const result = spawnSync('bash', ['-c', command], { stdio: 'inherit', cwd: ${JSON.stringify(dir)} })
process.exit(result.status ?? 1)
`)
  await chmod(bin, 0o755)
  process.env.PATH = `${dir}:${originalPath}`
  const target = { ssh: 'local-fixture', name: 'fixture', controlPersist: 0 }
  try {
    await run(dir, makeEditTool(target, dir, p => p), makeWriteTool(target, dir, p => p))
  } finally {
    process.env.PATH = originalPath
    delete process.env.REMOTE_SSH_TEST_CONFLICT_FILE
    await rm(dir, { recursive: true, force: true })
  }
}

test('remote edit preserves literal replacement metacharacters and the UTF-8 BOM', async () => {
  await withLocalSsh(async (dir, edit) => {
    const file = join(dir, 'text.txt')
    const replacement = "$& $$ $` $' ${HOME} 中文 😀"
    for (const replace_all of [false, true]) {
      await writeFile(file, '\uFEFFbefore old after\n')
      await edit.execute({ file_path: file, old_string: 'old', new_string: replacement, replace_all }, {})
      assert.equal(await readFile(file, 'utf8'), `\uFEFFbefore ${replacement} after\n`)
    }
  })
})

test('remote edit refuses invalid UTF-8 without rewriting the original bytes', async () => {
  await withLocalSsh(async (dir, edit) => {
    const file = join(dir, 'binary.txt')
    const original = Buffer.from([0x61, 0xff, 0x62])
    await writeFile(file, original)
    await assert.rejects(edit.execute({ file_path: file, old_string: 'a', new_string: 'c' }, {}), /UTF-8/)
    assert.deepEqual(await readFile(file), original)
  })
})

test('remote edit conflict treats shell syntax in a filename as literal text', async () => {
  await withLocalSsh(async (dir, edit) => {
    const file = join(dir, "quote'$(touch INJECTED).txt")
    await writeFile(file, 'original')
    process.env.REMOTE_SSH_TEST_CONFLICT_FILE = file
    await assert.rejects(edit.execute({ file_path: file, old_string: 'original', new_string: 'next' }, {}), /re-read/)
    assert.equal(await readFile(file, 'utf8'), 'concurrent edit with a different size')
    assert.deepEqual((await readdir(dir)).sort(), ["quote'$(touch INJECTED).txt", 'ssh'])
  })
})

test('remote write rejects a trailing high surrogate before touching the file', async () => {
  await withLocalSsh(async (dir, _edit, write) => {
    const file = join(dir, 'text.txt')
    await writeFile(file, 'original')
    await assert.rejects(write.execute({ file_path: file, content: 'broken\ud800' }, {}), /UTF-8/)
    assert.equal(await readFile(file, 'utf8'), 'original')
  })
})
