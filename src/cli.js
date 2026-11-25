#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer } from './server.js'
import { clearAllSudoPasswords } from './sudocache.js'

try {
  const { values } = parseArgs({ options: { targets: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) {
    process.stdout.write('Usage: remote-ssh-mcp [--targets /path/to/targets.json]\n\nTransport: stdio. Authentication: OpenSSH in a new terminal.\nEnvironment: REMOTE_SSH_TARGETS_FILE, REMOTE_SSH_CONTROL_DIR, REMOTE_SSH_TERMINAL, REMOTE_SSH_CONNECT_TIMEOUT_MS, REMOTE_SSH_SUDO_CACHE_MS, REMOTE_SSH_SERVER_ALIVE_INTERVAL, REMOTE_SSH_SERVER_ALIVE_COUNT_MAX, REMOTE_SSH_LOCK_TIMEOUT_MS, REMOTE_SSH_LOCK_GRACE_MS, REMOTE_SSH_LOCK_RETRY_MS (details in README.md)\n')
  } else {
    const handle = serveStdio(() => createServer({ storeFile: values.targets }), { onerror: error => console.error('remote-ssh:', error.message) })
    const close = async () => { clearAllSudoPasswords(); await handle.close(); process.exit(0) }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    process.stdin.once('end', close)
  }
} catch (error) {
  console.error('remote-ssh:', error.message)
  process.exitCode = 1
}
