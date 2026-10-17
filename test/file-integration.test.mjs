import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeEditTool, makeWriteTool } from '../src/tools/files.js'
import { installLocalSsh } from './helpers.mjs'

async function withLocalSsh(run) {
  const fake = await installLocalSsh()
  const target = { ssh: 'local-fixture', name: 'fixture', controlPersist: 0, root: fake.dir }
  try {
    await run(fake.dir, makeEditTool(target), makeWriteTool(target))
  } finally {
    await fake.cleanup()
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

test('remote edit detects a change during temp-file commit and treats filenames literally', async () => {
  await withLocalSsh(async (dir) => {
    const file = join(dir, "quote'$(touch INJECTED).txt")
    await writeFile(file, 'original')
    const helper = await readFile(new URL('../src/files.py', import.meta.url), 'utf8')
    // Inject an external writer at fchmod, before the final stat guard. No
    // production test hook or extra SSH round trip is needed.
    const injection = `import os, sys\nfrom pathlib import Path\nreal = os.fchmod\ndef changed(fd, mode):\n    Path(sys.argv[2]).write_text('concurrent edit with a different size')\n    real(fd, mode)\nos.fchmod = changed\n`
    const result = spawnSync('python3', ['-c', injection + helper, 'edit', file], {
      input: JSON.stringify({ old_string: 'original', new_string: 'next' }), encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /re-read/)
    assert.equal(await readFile(file, 'utf8'), 'concurrent edit with a different size')
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('.remote-ssh-tmp-') || name === 'INJECTED'))
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

test('remote writes fail closed if preserving existing permissions fails', async () => {
  await withLocalSsh(async (dir) => {
    const file = join(dir, 'private')
    await writeFile(file, 'original')
    const helper = await readFile(new URL('../src/files.py', import.meta.url), 'utf8')
    const injection = `import os\ndef fail(*args):\n    raise PermissionError('permission-copy failed')\nos.fchmod = fail\n`
    const result = spawnSync('python3', ['-c', injection + helper, 'edit', file], {
      input: JSON.stringify({ old_string: 'original', new_string: 'next' }), encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /permission-copy failed/)
    assert.equal(await readFile(file, 'utf8'), 'original')
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('.remote-ssh-tmp-')))
  })
})
