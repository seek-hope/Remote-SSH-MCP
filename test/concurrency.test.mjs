import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { manageTargets } from '../src/manage.js'
import { readTargetStoreStrict, saveTargetStore } from '../src/store.js'

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await delay(10)
  }
  throw new Error('concurrent operation did not reach its barrier')
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-concurrency-'))
  const env = { PATH: `${dir}:${process.env.PATH}`, REMOTE_SSH_CONTROL_DIR: join(dir, 'control'), SSH_CONCURRENCY_DIR: dir }
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  await writeFile(join(dir, 'ssh'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const dir = process.env.SSH_CONCURRENCY_DIR
const dest = args[args.indexOf('--') + 1]
const host = dest.replace(/-alias$/, '')
const socket = path.join(process.env.REMOTE_SSH_CONTROL_DIR, host)
fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify({ args, host }) + '\\n')
if (args.includes('-G')) { console.log('controlpath ' + socket); process.exit(0) }
if (args.includes('-O')) process.exit(fs.existsSync(socket) ? 0 : 255)
async function wait(file) {
  while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 10))
}
async function main() {
  if (args.includes('-f')) {
    fs.appendFileSync(path.join(dir, 'terminals'), host + '\\n')
    await wait(path.join(dir, 'release-' + host))
    fs.mkdirSync(path.dirname(socket), { recursive: true })
    fs.writeFileSync(socket, '')
    return 0
  }
  if (!args.includes('ControlMaster=no') && !fs.existsSync(socket)) {
    console.error('Permission denied (publickey,password).')
    return 255
  }
  if (host === 'slow') {
    fs.writeFileSync(path.join(dir, 'verifying'), '')
    await wait(path.join(dir, 'release-slow'))
  }
  const result = spawnSync('sh', ['-c', args.at(-1)], { stdio: 'inherit' })
  return result.status ?? 1
}
main().then(code => process.exit(code)).catch(error => { console.error(error); process.exit(1) })
`, { mode: 0o755 })
  const terminal = join(dir, 'terminal.cjs')
  await writeFile(terminal, `const { spawnSync } = require('node:child_process'); const r = spawnSync('sh', ['-c', process.argv.at(-1)], { stdio: 'inherit' }); process.exit(r.status ?? 1)\n`)
  env.REMOTE_SSH_TERMINAL = `"${process.execPath}" "${terminal}"`
  before.REMOTE_SSH_TERMINAL = process.env.REMOTE_SSH_TERMINAL
  Object.assign(process.env, env)
  const exists = file => readFile(join(dir, file)).then(() => true, () => false)
  try {
    await run({ dir, env, exists, file: join(dir, 'targets.json') })
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('independent MCP processes share authentication per socket while different hosts connect concurrently', async () => fixture(async ({ dir }) => {
  const sshModule = new URL('../src/ssh.js', import.meta.url).href
  const workers = ['alpha', 'alpha', 'alpha-alias', 'beta'].map(ssh => {
    const script = `import { ensureControlMaster } from ${JSON.stringify(sshModule)}; console.log(JSON.stringify(await ensureControlMaster(${JSON.stringify({ name: ssh, ssh, root: '/srv' })})))`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { err += data })
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)))
    })
    done.catch(() => {})
    return { child, done }
  })
  try {
    // Neither host is authenticated yet: both must reach their own terminal.
    await until(async () => {
      const terminals = await readFile(join(dir, 'terminals'), 'utf8').catch(() => '')
      const calls = (await readFile(join(dir, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
      return terminals.includes('alpha') && terminals.includes('beta') && calls.filter(c => c.args.includes('-O')).length >= 4
    })
    await Promise.all(['alpha', 'beta'].map(host => writeFile(join(dir, `release-${host}`), '')))
    const results = await Promise.all(workers.map(w => w.done))
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result))
    const terminals = (await readFile(join(dir, 'terminals'), 'utf8')).trim().split('\n').sort()
    assert.deepEqual(terminals, ['alpha', 'beta'], 'aliases of one socket must not open duplicate authentication terminals')
  } finally {
    await Promise.all(['alpha', 'beta'].map(host => writeFile(join(dir, `release-${host}`), '')))
    for (const worker of workers) worker.child.kill('SIGTERM')
    await Promise.allSettled(workers.map(w => w.done))
  }
}))

test('a target awaiting verification does not hold the configuration lock for other hosts', async () => fixture(async ({ dir, file, exists }) => {
  const slow = manageTargets({ action: 'add', name: 'slow', ssh: 'slow', root: dir, controlPersist: 0 }, file)
  let fast
  try {
    await until(() => exists('verifying'))
    let finished = false
    fast = manageTargets({ action: 'add', name: 'fast', ssh: 'fast', root: dir, controlPersist: 0 }, file)
      .then(result => { finished = true; return result })
    await until(() => finished)
    assert.deepEqual((await readTargetStoreStrict(file)).map(t => t.name), ['fast'])
  } finally {
    await writeFile(join(dir, 'release-slow'), '')
    await Promise.all([slow, fast])
  }
  assert.deepEqual((await readTargetStoreStrict(file)).map(t => t.name).sort(), ['fast', 'slow'])
}))

test('an update verified against stale target settings cannot overwrite a newer change', async () => fixture(async ({ dir, file, exists }) => {
  await saveTargetStore(file, [{ name: 'shared', ssh: 'slow', root: dir, controlPersist: 0 }])
  const update = manageTargets({ action: 'update', target: 'shared', root: '/' }, file).catch(error => error)
  try {
    await until(() => exists('verifying'))
    // Model a manual config change while authentication/verification is pending.
    await saveTargetStore(file, [{ name: 'shared', ssh: 'new-host', root: dir, controlPersist: 0 }])
  } finally {
    await writeFile(join(dir, 'release-slow'), '')
  }
  assert.match(String(await update), /changed.*retry/i)
  assert.equal((await readTargetStoreStrict(file))[0].ssh, 'new-host')
}))
