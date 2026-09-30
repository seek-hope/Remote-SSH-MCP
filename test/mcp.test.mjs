import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, chmod, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createServer } from '../src/server.js'
import { parseTargets } from '../src/target.js'
import { readTargetStoreStrict } from '../src/store.js'
import { ensureControlMaster, shq } from '../src/ssh.js'
import { remoteCommand } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const fakeSsh = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.REMOTE_TEST_LOG, JSON.stringify({ argv, pid: process.pid }) + '\\n')
if (argv.includes('-G')) { console.log('controlpath ' + process.env.REMOTE_SSH_CONTROL_DIR + '/fake'); process.exit(0) }
if (argv.includes('-O')) {
  if (argv.includes('exit')) fs.rmSync(process.env.REMOTE_TEST_MASTER, { force: true })
  process.exit(fs.existsSync(process.env.REMOTE_TEST_MASTER) || argv.includes('exit') ? 0 : 255)
}
if (argv.includes('-f')) {
  fs.writeFileSync(process.env.REMOTE_TEST_MASTER, '')
  process.exit(0)
}
if (process.env.REMOTE_TEST_AUTH && !fs.existsSync(process.env.REMOTE_TEST_MASTER)) {
  fs.writeSync(2, 'Permission denied (publickey,password).')
  process.exit(255)
}
const command = argv.at(-1)
const result = spawnSync('bash', ['-c', command], { stdio: 'inherit', env: process.env })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-mcp-'))
  const log = join(dir, 'ssh.log')
  const file = join(dir, 'config', 'targets.json')
  await writeFile(join(dir, 'ssh'), fakeSsh)
  await chmod(join(dir, 'ssh'), 0o755)
  const env = {
    PATH: `${dir}:${process.env.PATH}`, REMOTE_SSH_CONTROL_DIR: join(dir, 'control'),
    REMOTE_TEST_LOG: log, REMOTE_TEST_MASTER: join(dir, 'master'), REMOTE_SSH_JOB_DIR: join(dir, 'jobs'),
  }
  const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  const client = new Client({ name: 'test', version: '1.0.0' })
  const server = createServer({ storeFile: file })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = (name, args, options) => client.callTool({ name, arguments: args }, options)
  const json = async (name, args) => {
    const result = await call(name, args)
    assert.notEqual(result.isError, true, result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  try {
    await run({ dir, file, log, env, client, call, json })
  } finally {
    await client.close()
    await server.close()
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('MCP schemas, explicit target routing, CRUD and file operations', async () => fixture(async ({ dir, file, client, call, json, log }) => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['bash', 'edit', 'glob', 'grep', 'job_kill', 'job_output', 'read', 'remote_ssh_targets', 'sudo', 'write'])
  for (const tool of tools.filter(t => t.name !== 'remote_ssh_targets')) assert.ok(tool.inputSchema.required.includes('target'))
  assert.ok(!JSON.stringify(tools.map(t => t.inputSchema)).includes('password'))
  assert.equal((await call('read', { file_path: 'x' })).isError, true)
  assert.equal((await call('read', { target: 'absent', file_path: 'x' })).isError, true)
  assert.equal((await call('remote_ssh_targets', { action: 'add', ssh: '-oProxyCommand=bad', root: dir })).isError, true)
  assert.deepEqual(await json('remote_ssh_targets', { action: 'list' }), { targets: [], storeFile: file })
  assert.equal(await readFile(log, 'utf8').catch(() => ''), '')
  for (const name of ['alpha', 'beta']) {
    await json('remote_ssh_targets', { action: 'add', name, ssh: `${name}-host:2200`, root: join(dir, name), create: true, controlPersist: 0 })
  }
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await readTargetStoreStrict(file))[0].port, 2200)
  const args = { target: 'alpha', file_path: "quote'$.txt" }
  assert.notEqual((await call('write', { ...args, content: 'hello 中文\nsecond\n' })).isError, true)
  assert.notEqual((await call('edit', { ...args, old_string: 'hello', new_string: '$& next' })).isError, true)
  assert.match((await call('read', args)).content[0].text, /1\t\$& next 中文/)
  assert.match((await call('glob', { target: 'alpha', pattern: '**/*.txt' })).content[0].text, /quote/)
  assert.match((await call('grep', { target: 'alpha', pattern: 'second' })).content[0].text, /2:second/)
  assert.match((await call('grep', { target: 'alpha', pattern: 'second', path: args.file_path })).content[0].text, /2:second/)
  assert.equal((await call('grep', { target: 'alpha', pattern: '[' })).isError, true)
  assert.equal((await call('read', { ...args, target: 'beta' })).isError, true)
  assert.match((await call('bash', { target: 'beta', command: 'pwd; exit 7' })).content[0].text, /beta\n\[exit code: 7\]/)
  assert.equal((await call('read', { ...args, offset: 0 })).isError, true)
  await json('remote_ssh_targets', { action: 'update', target: 'alpha', name: 'renamed', port: null })
  assert.equal((await call('read', args)).isError, true)
  assert.equal((await readTargetStoreStrict(file))[0].port, undefined)
  await json('remote_ssh_targets', { action: 'remove', target: 'renamed' })
  assert.equal((await json('remote_ssh_targets', { action: 'list' })).targets.length, 1)
  const corrupt = '[{"name":"broken"}]'
  await writeFile(file, corrupt)
  assert.equal((await call('remote_ssh_targets', { action: 'add', name: 'x', ssh: 'host', root: dir })).isError, true)
  assert.equal(await readFile(file, 'utf8'), corrupt)
}))

test('background jobs preserve final output, paginate, survive a client restart and can be killed', async () => fixture(async ({ dir, file, env, call, json }) => {
  await json('remote_ssh_targets', { action: 'add', name: 'jobs', ssh: 'job-host', root: dir, controlPersist: 0 })
  const started = JSON.parse((await call('bash', { target: 'jobs', command: "printf 'first-second'; exit 7", run_in_background: true })).content[0].text)
  const args = { target: 'jobs', job_id: started.job_id }
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--targets', file], env, stderr: 'pipe' })
  const restarted = new Client({ name: 'restarted', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  try {
    await restarted.connect(transport)
    assert.equal(restarted.getNegotiatedProtocolVersion(), '2026-07-28')
    let result
    for (let i = 0; i < 50; i++) {
      result = JSON.parse((await restarted.callTool({ name: 'job_output', arguments: { ...args, limit: 5 } })).content[0].text)
      if (result.status !== 'running') break
      await delay(20)
    }
    assert.equal(result.status, 'completed')
    assert.equal(result.exit_code, 7)
    assert.equal(result.output, 'first')
    assert.equal(result.next_offset, 5)
    assert.equal(result.has_more, true)
    const last = await json('job_output', { ...args, offset: result.next_offset, cleanup: true })
    assert.equal(last.output, '-second')
    assert.equal(last.cleaned_up, true)
  } finally {
    await restarted.close()
  }
  const long = JSON.parse((await call('bash', { target: 'jobs', command: 'sleep 30', run_in_background: true })).content[0].text)
  try {
    const killed = await json('job_kill', { target: 'jobs', job_id: long.job_id })
    assert.equal(killed.status, 'killed')
  } finally {
    await json('job_output', { target: 'jobs', job_id: long.job_id, cleanup: true })
  }
  assert.equal((await call('job_kill', { target: 'jobs', job_id: '../../something' })).isError, true)
}))

test('password authentication launches a terminal with standard SSH flags and reuses its master', async () => fixture(async ({ dir, log }) => {
  const terminal = join(dir, 'terminal.cjs')
  await writeFile(terminal, `const { spawnSync } = require('node:child_process'); const fs = require('node:fs'); const command = process.argv.at(-1); fs.writeFileSync(${JSON.stringify(join(dir, 'terminal-command'))}, command); const r = spawnSync('bash', ['-c', command], { stdio: 'ignore' }); process.exit(r.status ?? 1);`)
  process.env.REMOTE_SSH_TERMINAL = `${process.execPath} ${terminal}`
  process.env.REMOTE_TEST_AUTH = '1'
  try {
    const target = { name: 'password-host', ssh: 'password-host', root: dir }
    const ready = await ensureControlMaster(target)
    assert.equal(ready.ok, true, JSON.stringify(ready))
    assert.equal(ready.mode, 'terminal')
    assert.equal((await ensureControlMaster(target)).mode, 'reused')
    const command = await readFile(join(dir, 'terminal-command'), 'utf8')
    assert.match(command, /BatchMode=no/)
    assert.match(command, /StrictHostKeyChecking=ask/)
    assert.match(command, /'-f' '-N'/)
    assert.doesNotMatch(command, /ASKPASS|SECRET|password=/)
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls.filter(c => c.argv.includes('-f')).length, 1)
    assert.ok(calls.some(c => c.argv.includes('BatchMode=yes') && c.argv.includes('StrictHostKeyChecking=yes')))
  } finally {
    delete process.env.REMOTE_SSH_TERMINAL
    delete process.env.REMOTE_TEST_AUTH
  }
}))

test('target validation rejects duplicates and secrets; paths and IPv6 normalize', () => {
  assert.throws(() => parseTargets([{ ssh: 'h', root: '/r', password: 'never-store' }]))
  assert.throws(() => parseTargets([{ name: 'x', ssh: 'a', root: '/r' }, { name: 'x', ssh: 'b', root: '/r' }]), /Duplicate/)
  assert.throws(() => parseTargets([{ ssh: 'h', root: '/r/../x' }]))
  const [target] = parseTargets([{ ssh: 'user@[::1]:2222', root: '//srv/./proj/' }])
  assert.equal(target.ssh, 'user@::1')
  assert.equal(target.port, 2222)
  assert.equal(target.root, '/srv/proj')
})

test('MCP cancellation reaches the SSH subprocess', async () => fixture(async ({ dir, json, call, log }) => {
  await json('remote_ssh_targets', { action: 'add', name: 'cancel', ssh: 'cancel-host', root: dir, controlPersist: 0 })
  const controller = new AbortController()
  const running = call('bash', { target: 'cancel', command: 'sleep 1.5' }, { signal: controller.signal }).catch(error => error)
  let pid
  try {
    for (let i = 0; i < 100; i++) {
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
      pid = calls.find(row => remoteCommand(row.argv).includes('sleep 1.5'))?.pid
      if (pid) break
      await delay(10)
    }
    assert.ok(pid, 'SSH subprocess started')
    controller.abort()
    assert.ok(await running instanceof Error)
    let exited = false
    for (let i = 0; i < 100 && !exited; i++) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') exited = true; else throw error }
      if (!exited) await delay(10)
    }
    assert.ok(exited, 'Cancellation killed the local SSH client')
  } finally {
    controller.abort()
    await running
  }
}))

test('independent stdio clients run concurrent calls on shared and different hosts with isolated cancellation', async () => fixture(async ({ dir, file, env, json, log }) => {
  await writeFile(env.REMOTE_TEST_MASTER, '')
  for (const [name, ssh] of [['alpha', 'shared-host'], ['alpha-other-root', 'shared-host'], ['beta', 'other-host']]) {
    await json('remote_ssh_targets', { action: 'add', name, ssh, root: join(dir, name), create: true })
  }
  const clients = [0, 1].map(i => new Client({ name: `agent-${i}`, version: '1' }, { versionNegotiation: { mode: 'auto' } }))
  const release = join(dir, 'release')
  const targets = ['alpha', 'beta', 'alpha-other-root', 'alpha', 'beta', 'alpha-other-root']
  const controller = new AbortController()
  const pending = []
  try {
    await Promise.all(clients.map(client => client.connect(new StdioClientTransport({
      command: process.execPath, args: [CLI, '--targets', file], env, stderr: 'pipe',
    }))))
    for (const [i, target] of targets.entries()) {
      const command = `touch ${shq(join(dir, `started-${i}`))}; while [ ! -f ${shq(release)} ]; do sleep 0.02; done; printf 'call-${i}:'; pwd`
      pending.push(clients[i % 2].callTool({ name: 'bash', arguments: { target, command } }, i === 0 ? { signal: controller.signal } : undefined).catch(error => error))
    }
    let started
    for (let i = 0; i < 300; i++) {
      started = await Promise.all(targets.map((_, i) => stat(join(dir, `started-${i}`)).then(() => true, () => false)))
      if (started.every(Boolean)) break
      await delay(10)
    }
    assert.ok(started.every(Boolean), 'All six commands entered before any was released')
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const pid = calls.find(row => remoteCommand(row.argv).includes('started-0'))?.pid
    assert.ok(pid)
    controller.abort()
    assert.ok(await pending[0] instanceof Error)
    let exited = false
    for (let i = 0; i < 100 && !exited; i++) {
      try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') exited = true; else throw error }
      if (!exited) await delay(10)
    }
    assert.ok(exited, 'Cancellation reached only the selected SSH subprocess')
    await writeFile(release, '')
    for (const [i, result] of (await Promise.all(pending)).entries()) {
      if (i === 0) continue
      assert.notEqual(result.isError, true)
      assert.equal(result.content[0].text.trim(), `call-${i}:${join(dir, targets[i])}\n[exit code: 0]`)
    }
    const after = await clients[0].callTool({ name: 'bash', arguments: { target: 'alpha', command: 'printf still-connected' } })
    assert.equal(after.content[0].text, 'still-connected\n[exit code: 0]')
  } finally {
    controller.abort()
    await writeFile(release, '')
    await Promise.all(pending)
    await Promise.all(clients.map(client => client.close()))
  }
}))

test('stdio supports legacy MCP initialization and keeps stdout protocol-only', async () => {
  const child = spawn(process.execPath, [CLI])
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  let buffer = ''
  const responses = []
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      responses.push(JSON.parse(buffer.slice(0, newline)))
      buffer = buffer.slice(newline + 1)
    }
  })
  const send = message => child.stdin.write(JSON.stringify(message) + '\n')
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } })
    for (let i = 0; i < 100 && !responses.some(r => r.id === 1); i++) await delay(10)
    assert.equal(responses.find(r => r.id === 1)?.result.serverInfo.name, 'remote-ssh')
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    for (let i = 0; i < 100 && !responses.some(r => r.id === 2); i++) await delay(10)
    assert.equal(responses.find(r => r.id === 2)?.result.tools.length, 10)
  } finally {
    child.stdin.end()
    const deadline = setTimeout(() => child.kill('SIGKILL'), 2000)
    await exited
    clearTimeout(deadline)
  }
})
