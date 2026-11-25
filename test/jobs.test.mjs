import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { shq } from '../src/ssh.js'

const exec = promisify(execFile)
const script = fileURLToPath(new URL('../src/jobs.py', import.meta.url))
const linux = { skip: process.platform !== 'linux' }
async function until(check) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(25)
  }
  throw new Error('job did not reach expected state')
}
async function identity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
    return { pid, state: fields[0], pgid: Number(fields[2]), stamp: fields[19] }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
    throw error
  }
}
async function alive(record) {
  const current = await identity(record.pid)
  return current && current.state !== 'Z' && current.stamp === record.stamp
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-lifecycle-'))
  const job_id = randomUUID()
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const stateFile = join(env.REMOTE_SSH_JOB_DIR, job_id, 'state.json')
  const ready = join(dir, 'child.json')
  const term = join(dir, 'term')
  let worker, child
  const invoke = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify({ job_id, ...request }))
    return JSON.parse((await proc).stdout)
  }
  const start = async (wait = true) => {
    const code = `import os,signal,time,json; from pathlib import Path; signal.signal(signal.SIGTERM,lambda *_: Path(${JSON.stringify(term)}).touch()); Path(${JSON.stringify(ready)}).write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()})); time.sleep(30)`
    await invoke({ action: 'start', command: `python3 -c ${shq(code)} &${wait ? ' wait' : ''}`, workdir: dir })
    worker = JSON.parse(await readFile(stateFile, 'utf8'))
    await until(async () => {
      const value = await readFile(ready, 'utf8').then(JSON.parse).catch(() => undefined)
      if (!value) return false
      child = await identity(value.pid)
      return !!child
    })
    assert.equal(child.pgid, worker.pid, 'child has not escaped the job process group')
    return { worker, child }
  }
  try {
    await run({ dir, job_id, env, invoke, start, term })
  } finally {
    // Never leave the deliberately stubborn test process behind, even on an
    // assertion failure. Start stamps protect against signalling a reused PID.
    if (worker && await alive(worker)) {
      try { process.kill(-worker.pid, 'SIGKILL') } catch {}
    }
    if (child && await alive(child)) {
      try { process.kill(child.pid, 'SIGKILL') } catch {}
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('job_kill escalates for a same-group TERM-resistant descendant after its shell exits', linux, async () => fixture(async ({ invoke, start }) => {
  const { worker, child } = await start()
  const result = await invoke({ action: 'kill' })
  assert.equal(result.status, 'killed')
  await until(async () => !await alive(child))
  assert.equal(!!await alive(worker), false)
  assert.equal((await invoke({ action: 'output', cleanup: true })).cleaned_up, true)
}))

test('a shell exiting before its background child does not permit premature cleanup', linux, async () => fixture(async ({ invoke, start }) => {
  const { child } = await start(false)
  assert.equal((await invoke({ action: 'output' })).status, 'running')
  await assert.rejects(invoke({ action: 'output', cleanup: true }), /Cleanup requires a finished job/)
  assert.equal((await invoke({ action: 'kill' })).status, 'killed')
  await until(async () => !await alive(child))
}))

test('a worker killed after its child starts leaves a lost job and refuses cleanup', linux, async () => fixture(async ({ invoke, start }) => {
  const { worker, child } = await start()
  process.kill(worker.pid, 'SIGKILL')
  await until(async () => (await invoke({ action: 'output' })).status === 'lost')
  const result = await invoke({ action: 'output' })
  assert.equal(result.status, 'lost')
  assert.equal(result.worker_missing, true)
  assert.match(result.warning, /descendants may still be running/)
  await assert.rejects(invoke({ action: 'output', cleanup: true }), /lost job/)
  assert.equal(await alive(child), true, 'the surviving child is not silently forgotten')
}))

test('a worker killed after a kill request is lost and cannot be cleaned up', linux, async () => fixture(async ({ invoke, start, job_id, env }) => {
  const { worker, child } = await start()
  // job_kill writes this marker before signalling; the worker then dies
  // without proving its members stopped.
  await writeFile(join(env.REMOTE_SSH_JOB_DIR, job_id, 'killed'), '')
  process.kill(worker.pid, 'SIGKILL')
  await until(async () => (await invoke({ action: 'output' })).status === 'lost')
  const result = await invoke({ action: 'output' })
  assert.equal(result.status, 'lost')
  assert.equal(result.worker_missing, true)
  await assert.rejects(invoke({ action: 'output', cleanup: true }), /lost job/)
  assert.equal(await alive(child), true, 'the surviving child is not silently forgotten')
}))

test('TERM/KILL escalation survives losing the job_kill request process', linux, async () => fixture(async ({ job_id, env, start, term }) => {
  const { worker, child } = await start()
  const request = spawn('python3', [script], { env, stdio: ['pipe', 'ignore', 'ignore'] })
  const closed = new Promise(resolve => request.once('close', resolve))
  request.stdin.end(JSON.stringify({ job_id, action: 'kill' }))
  try {
    await until(() => readFile(term).then(() => true, () => false))
    request.kill('SIGKILL')
    await closed
    await until(async () => !await alive(worker) && !await alive(child))
  } finally {
    request.kill('SIGKILL')
    await closed
  }
}))

test('job output keeps a UTF-8 character split at a page boundary', linux, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-utf8-'))
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const job_id = randomUUID()
  const job = join(env.REMOTE_SSH_JOB_DIR, job_id)
  const call = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify(request))
    return JSON.parse((await proc).stdout)
  }
  try {
    await mkdir(job, { recursive: true })
    const prefix = 'a'.repeat(65535)
    await writeFile(join(job, 'out'), prefix + '中' + 'tail')
    await writeFile(join(job, 'state.json'), JSON.stringify({ pid: 999999, stamp: '0', version: 3 }))
    await writeFile(join(job, 'exit'), '0')
    await writeFile(join(job, 'done'), '')
    const first = await call({ action: 'output', job_id, limit: 65536 })
    assert.equal(first.output, prefix)
    assert.equal(first.next_offset, 65535)
    assert.equal(first.has_more, true)
    const second = await call({ action: 'output', job_id, offset: first.next_offset, limit: 65536 })
    assert.ok(second.output.startsWith('中'))
    assert.equal(second.next_offset, 65535 + 3 + 4)
    assert.equal(second.has_more, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a background command larger than the argv limit runs from a script file', linux, async () => fixture(async ({ dir, invoke, job_id }) => {
  const command = '#'.repeat(140_000) + '\nprintf ok'
  assert.equal((await invoke({ action: 'start', job_id, workdir: dir, command })).status, 'started')
  let result
  for (let i = 0; i < 200; i++) {
    result = await invoke({ action: 'output', job_id, limit: 100 })
    if (result.status !== 'running') break
    await delay(25)
  }
  assert.equal(result.status, 'completed')
  assert.equal(result.exit_code, 0)
  assert.match(result.output, /ok/)
}))

test('job output preserves a UTF-8 character split at a running job current EOF', linux, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-utf8-live-'))
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const job_id = randomUUID()
  const job = join(env.REMOTE_SSH_JOB_DIR, job_id)
  const raw = await readFile('/proc/self/stat', 'utf8')
  const stamp = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]
  const call = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify(request))
    return JSON.parse((await proc).stdout)
  }
  try {
    await mkdir(job, { recursive: true })
    const prefix = 'a'.repeat(65534)
    await writeFile(join(job, 'out'), Buffer.concat([Buffer.from(prefix), Buffer.from([0xe4])]))
    await writeFile(join(job, 'state.json'), JSON.stringify({ pid: process.pid, stamp, version: 3 }))
    const first = await call({ action: 'output', job_id, limit: 65536 })
    assert.equal(first.status, 'running')
    assert.equal(first.output, prefix)
    assert.equal(first.next_offset, 65534)
    assert.equal(first.has_more, true)
    await writeFile(join(job, 'out'), Buffer.concat([Buffer.from(prefix), Buffer.from('中tail')]))
    const second = await call({ action: 'output', job_id, offset: first.next_offset, limit: 65536 })
    assert.ok(second.output.startsWith('中tail'))
    assert.equal(second.next_offset, 65534 + 3 + 4)
    assert.equal(second.has_more, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a v2 job with an exit file stays completed and cleanable', linux, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-v2-'))
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const job_id = randomUUID()
  const job = join(env.REMOTE_SSH_JOB_DIR, job_id)
  const call = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify(request))
    return JSON.parse((await proc).stdout)
  }
  try {
    await mkdir(job, { recursive: true })
    await writeFile(join(job, 'out'), 'old')
    await writeFile(join(job, 'state.json'), JSON.stringify({ pid: 999999, stamp: '0', version: 2 }))
    await writeFile(join(job, 'exit'), '0')
    const out = await call({ action: 'output', job_id })
    assert.equal(out.status, 'completed')
    assert.equal(out.worker_missing, undefined)
    const cleaned = await call({ action: 'output', job_id, cleanup: true })
    assert.equal(cleaned.cleaned_up, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('job_output requires a limit that can advance over a multi-byte character', linux, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-limit-'))
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const job_id = randomUUID()
  const job = join(env.REMOTE_SSH_JOB_DIR, job_id)
  const call = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify(request))
    return JSON.parse((await proc).stdout)
  }
  try {
    await mkdir(job, { recursive: true })
    await writeFile(join(job, 'out'), '😀x')
    await writeFile(join(job, 'state.json'), JSON.stringify({ pid: 999999, stamp: '0', version: 3 }))
    await writeFile(join(job, 'exit'), '0')
    await writeFile(join(job, 'done'), '')
    for (const limit of [1, 2, 3]) {
      await assert.rejects(call({ action: 'output', job_id, limit }), /limit must be between 4 and 65536/)
    }
    const first = await call({ action: 'output', job_id, limit: 4 })
    assert.equal(first.output, '😀')
    assert.equal(first.next_offset, 4)
    assert.equal(first.has_more, true)
    const rest = await call({ action: 'output', job_id, offset: first.next_offset, limit: 4 })
    assert.equal(rest.output, 'x')
    assert.equal(rest.has_more, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an uppercase UUID addresses the same job', linux, async () => fixture(async ({ invoke, job_id, dir }) => {
  assert.equal((await invoke({ action: 'start', job_id, workdir: dir, command: 'echo ok' })).status, 'started')
  let out
  for (let i = 0; i < 100; i++) {
    out = await invoke({ action: 'output', job_id: job_id.toUpperCase(), limit: 65536 })
    if (out.status !== 'running') break
    await delay(25)
  }
  assert.equal(out.status, 'completed')
  assert.match(out.output, /ok/)
}))

test('job_output keeps a partial trailing character pending for a lost job', linux, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-partial-'))
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const job_id = randomUUID()
  const job = join(env.REMOTE_SSH_JOB_DIR, job_id)
  const call = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify(request))
    return JSON.parse((await proc).stdout)
  }
  try {
    await mkdir(job, { recursive: true })
    await writeFile(join(job, 'out'), Buffer.from('😀').subarray(0, 3))
    await writeFile(join(job, 'state.json'), JSON.stringify({ pid: 999999, stamp: '0', version: 3 }))
    await writeFile(join(job, 'exit'), '0')
    const out = await call({ action: 'output', job_id, limit: 4 })
    assert.equal(out.status, 'lost')
    assert.equal(out.output, '')
    assert.equal(out.next_offset, 0, 'the incomplete character is not split')
    assert.equal(out.has_more, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a v3 job with an exit file but no done marker is lost and refuses cleanup', linux, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-nodone-'))
  const env = { ...process.env, REMOTE_SSH_JOB_DIR: join(dir, 'jobs') }
  const job_id = randomUUID()
  const job = join(env.REMOTE_SSH_JOB_DIR, job_id)
  const call = async request => {
    const proc = exec('python3', [script], { env, timeout: 10000 })
    proc.child.stdin.end(JSON.stringify(request))
    return JSON.parse((await proc).stdout)
  }
  try {
    await mkdir(job, { recursive: true })
    await writeFile(join(job, 'out'), 'x')
    await writeFile(join(job, 'state.json'), JSON.stringify({ pid: 999999, stamp: '0', version: 3 }))
    await writeFile(join(job, 'exit'), '0')
    const out = await call({ action: 'output', job_id })
    assert.equal(out.status, 'lost')
    assert.equal(out.worker_missing, true)
    await assert.rejects(call({ action: 'output', job_id, cleanup: true }), /lost job/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a set -m descendant in the same session keeps the job running and is killed', linux, async () => fixture(async ({ invoke, job_id, dir }) => {
  assert.equal((await invoke({ action: 'start', job_id, workdir: dir, command: 'set -m; sleep 10 &' })).status, 'started')
  let status
  for (let i = 0; i < 50; i++) {
    const out = await invoke({ action: 'output', job_id, limit: 8 })
    status = out.status
    if (status !== 'running') break
    await delay(20)
  }
  assert.equal(status, 'running')
  assert.equal((await invoke({ action: 'kill', job_id })).status, 'killed')
  await until(async () => (await invoke({ action: 'output', job_id, limit: 8 })).status === 'killed')
}))

test('an undecodable /proc comm does not break job bookkeeping', linux, async () => {
  const bad = spawn('python3', ['-c', 'import ctypes,time; ctypes.CDLL(None).prctl(15, b"bad\\xffcomm", 0, 0, 0); time.sleep(5)'])
  bad.unref()
  try {
    // Guard against a vacuous test: the helper must really expose a comm that
    // strict UTF-8 decoding rejects, or members()/alive() never see it.
    let undecodable = false
    for (let i = 0; i < 100 && !undecodable && bad.exitCode === null; i++) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(`/proc/${bad.pid}/stat`))
        await delay(10)
      } catch (error) {
        // Only an actual UTF-8 decode failure counts; a missing/unreadable
        // proc file must not satisfy the guard.
        if (!(error instanceof TypeError)) throw error
        undecodable = true
      }
    }
    assert.equal(undecodable, true, 'the helper must expose an undecodable comm')
    assert.equal(bad.exitCode, null, 'the helper is still alive')
    await fixture(async ({ invoke, job_id, dir }) => {
      assert.equal((await invoke({ action: 'start', job_id, workdir: dir, command: 'sleep 0.2; echo ok' })).status, 'started')
      let out
      for (let i = 0; i < 100; i++) {
        out = await invoke({ action: 'output', job_id, limit: 65536 })
        if (out.status !== 'running') break
        await delay(25)
      }
      assert.equal(out.status, 'completed')
      assert.equal(out.exit_code, 0)
      assert.match(out.output, /ok/)
    })
  } finally {
    bad.kill('SIGKILL')
  }
})

test('a background command keeps the account umask', { skip: process.platform !== 'linux' }, async () => {
  const previous = process.umask(0o022)
  try {
    await fixture(async ({ invoke, job_id, dir }) => {
      assert.equal((await invoke({ action: 'start', job_id, workdir: dir, command: 'touch created' })).status, 'started')
      let out
      for (let i = 0; i < 100; i++) {
        out = await invoke({ action: 'output', job_id, limit: 65536 })
        if (out.status !== 'running') break
        await delay(25)
      }
      assert.equal(out.status, 'completed')
      assert.equal((await stat(join(dir, 'created'))).mode & 0o777, 0o644)
    })
  } finally {
    process.umask(previous)
  }
})

test('an extreme account umask still leaves a usable job record', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ invoke, job_id, dir }) => {
    const previous = process.umask(0o777)
    try {
      assert.equal((await invoke({ action: 'start', job_id, workdir: dir, command: 'touch created' })).status, 'started')
    } finally {
      process.umask(previous)
    }
    let out
    for (let i = 0; i < 100; i++) {
      out = await invoke({ action: 'output', job_id, limit: 65536 })
      if (out.status !== 'running') break
      await delay(25)
    }
    assert.equal(out.status, 'completed')
    assert.equal(out.exit_code, 0)
    const jobDir = join(dir, 'jobs', job_id)
    assert.equal((await stat(join(jobDir, 'state.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(jobDir, 'command.sh'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(dir, 'created'))).mode & 0o777, 0)
  })
})

test('a background command sources BASH_ENV exactly once', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-job-bashenv-'))
  const marker = join(dir, 'sourced')
  const script = join(dir, 'env.sh')
  await writeFile(script, `printf x >> ${JSON.stringify(marker)}\n`)
  const previous = process.env.BASH_ENV
  process.env.BASH_ENV = script
  try {
    await fixture(async ({ invoke, job_id, dir: workdir }) => {
      assert.equal((await invoke({ action: 'start', job_id, workdir, command: 'true' })).status, 'started')
      let out
      for (let i = 0; i < 100; i++) {
        out = await invoke({ action: 'output', job_id, limit: 65536 })
        if (out.status !== 'running') break
        await delay(25)
      }
      assert.equal(out.status, 'completed')
      assert.equal(await readFile(marker, 'utf8'), 'x')
    })
  } finally {
    if (previous === undefined) delete process.env.BASH_ENV
    else process.env.BASH_ENV = previous
    await rm(dir, { recursive: true, force: true })
  }
})
