import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
