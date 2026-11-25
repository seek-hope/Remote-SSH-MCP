import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearAllSudoPasswords,
  clearCachedSudoPassword,
  dropCachedSudoPassword,
  getCachedSudoPassword,
  getCachedSudoPasswordEntry,
  setCachedSudoPassword,
  sudoCacheGeneration,
  sudoCacheKey,
  sudoCacheSize,
  sudoCacheTtlMs,
} from '../src/sudocache.js'

const key = sudoCacheKey({ ssh: 'host', port: 2222 })

test('the default lifetime is 20 minutes and the env override is honored', () => {
  const previous = process.env.REMOTE_SSH_SUDO_CACHE_MS
  try {
    delete process.env.REMOTE_SSH_SUDO_CACHE_MS
    assert.equal(sudoCacheTtlMs(), 20 * 60 * 1000)
    process.env.REMOTE_SSH_SUDO_CACHE_MS = '0'
    assert.equal(sudoCacheTtlMs(), 0)
    process.env.REMOTE_SSH_SUDO_CACHE_MS = '60000'
    assert.equal(sudoCacheTtlMs(), 60_000)
    process.env.REMOTE_SSH_SUDO_CACHE_MS = '-1'
    assert.throws(() => sudoCacheTtlMs(), /non-negative integer/)
    process.env.REMOTE_SSH_SUDO_CACHE_MS = 'soon'
    assert.throws(() => sudoCacheTtlMs(), /non-negative integer/)
  } finally {
    if (previous === undefined) delete process.env.REMOTE_SSH_SUDO_CACHE_MS
    else process.env.REMOTE_SSH_SUDO_CACHE_MS = previous
  }
})

test('cached passwords are copies, expire on their absolute deadline, and never cross destinations', () => {
  clearAllSudoPasswords()
  const secret = Buffer.from('hunter2')
  assert.equal(setCachedSudoPassword(key, secret, 1000, 1000), true)

  const first = getCachedSudoPassword(key, 1500)
  assert.equal(first?.toString(), 'hunter2')
  assert.notEqual(first, secret, 'the cache hands out a private copy')
  first.fill(0)
  // Wiping a caller's copy must not affect the cached secret or other callers.
  assert.equal(getCachedSudoPassword(key, 1500)?.toString(), 'hunter2')

  assert.equal(getCachedSudoPassword(sudoCacheKey({ ssh: 'other' }), 1500), undefined)
  assert.equal(getCachedSudoPassword(key, 2000), undefined, 'the TTL is absolute, not sliding')
  assert.equal(sudoCacheSize(), 0)
  clearAllSudoPasswords()
})

test('the expiry timer wipes an entry even when nothing reads it again', async () => {
  clearAllSudoPasswords()
  setCachedSudoPassword(key, Buffer.from('x'), 50)
  assert.equal(sudoCacheSize(), 1)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(sudoCacheSize(), 0, 'the deadline timer removed the entry')
})

test('an explicit clear invalidates a prompt that started earlier', () => {
  clearAllSudoPasswords()
  const generation = sudoCacheGeneration(key)
  clearCachedSudoPassword(key)
  assert.equal(setCachedSudoPassword(key, Buffer.from('x'), 1000, Date.now(), generation), false,
    'a credential cleared while the prompt was open must not be resurrected')
  assert.equal(sudoCacheSize(), 0)

  const beforeReset = sudoCacheGeneration(key)
  clearAllSudoPasswords()
  assert.equal(setCachedSudoPassword(key, Buffer.from('x'), 1000, Date.now(), beforeReset), false)
  assert.equal(sudoCacheSize(), 0)
})

test('a non-positive TTL disables storage and clearing drops the entry', () => {
  clearAllSudoPasswords()
  assert.equal(setCachedSudoPassword(key, Buffer.from('x'), 0), false)
  assert.equal(sudoCacheSize(), 0)

  assert.notEqual(sudoCacheKey({ ssh: 'a' }), sudoCacheKey({ ssh: 'a', port: 22 }))
  assert.equal(sudoCacheKey({ ssh: 'a', port: 22 }), sudoCacheKey({ ssh: 'a', port: 22 }))

  setCachedSudoPassword(key, Buffer.from('x'), 1000)
  assert.equal(sudoCacheSize(), 1)
  clearCachedSudoPassword(key)
  assert.equal(sudoCacheSize(), 0)
  assert.equal(getCachedSudoPassword(key), undefined)
})

test('entries are bound to the resolved SSH identity and their own token', () => {
  clearAllSudoPasswords()
  setCachedSudoPassword(key, Buffer.from('x'), 1000, 1000, undefined, 'host\u0000user\u000022')
  const entry = getCachedSudoPasswordEntry(key, { now: 1500, identity: 'host\u0000user\u000022' })
  assert.equal(entry?.password.toString(), 'x')
  assert.equal(getCachedSudoPasswordEntry(key, { now: 1500, identity: 'host\u0000other\u000022' }), undefined)
  assert.equal(sudoCacheSize(), 1, 'another identity cannot read the slot, and does not drop it')

  setCachedSudoPassword(key, Buffer.from('x'), 1000, 1000, undefined, 'h\u0000u\u000022')
  const first = getCachedSudoPasswordEntry(key, { now: 1500, identity: 'h\u0000u\u000022' })
  setCachedSudoPassword(key, Buffer.from('y'), 1000, 1000, undefined, 'h\u0000u\u000022')
  dropCachedSudoPassword(key, first.token)
  assert.equal(getCachedSudoPasswordEntry(key, { now: 1500, identity: 'h\u0000u\u000022' })?.password.toString(), 'y',
    'a stale failure cannot drop a newer entry')
  clearAllSudoPasswords()
})

test('an identity-bound entry is not reused when identity resolution fails', () => {
  clearAllSudoPasswords()
  setCachedSudoPassword(key, Buffer.from('x'), 1000, 1000, undefined, 'host\u0000user\u000022')
  assert.equal(getCachedSudoPasswordEntry(key, { now: 1500 }), undefined,
    'an unverifiable credential is not used')
  assert.equal(sudoCacheSize(), 1, 'the verified identity slot remains valid')

  // Without ssh -G on either call the alias key is all the binding available.
  setCachedSudoPassword(key, Buffer.from('y'), 1000, 1000)
  assert.equal(getCachedSudoPasswordEntry(key, { now: 1500 })?.password.toString(), 'y')
  clearAllSudoPasswords()
})

test('different resolved identities use separate slots and do not drop each other', () => {
  clearAllSudoPasswords()
  setCachedSudoPassword(key, Buffer.from('a'), 1000, 1000, undefined, 'host-a\u0000u\u000022')
  setCachedSudoPassword(key, Buffer.from('b'), 1000, 1000, undefined, 'host-b\u0000u\u000022')
  assert.equal(sudoCacheSize(), 2)
  assert.equal(getCachedSudoPasswordEntry(key, { now: 1500, identity: 'host-a\u0000u\u000022' })?.password.toString(), 'a')
  assert.equal(getCachedSudoPasswordEntry(key, { now: 1500, identity: 'host-b\u0000u\u000022' })?.password.toString(), 'b')
  clearCachedSudoPassword(key)
  assert.equal(sudoCacheSize(), 0, 'a destination clear drops every identity slot')
})
