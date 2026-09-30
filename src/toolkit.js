/**
 * toolkit.js — shared definitions for the remote workspace tools.
 *
 * The MCP adapter (server.js) publishes the JSON schemas through Zod.
 * checkArgs only backstops DIRECT callers (tests import the make*Tool
 * factories); on the MCP path Zod has already validated every argument.
 */

/**
 * Validate args against a tiny spec: { field: 'string'|'number'|'boolean'|'?string'|... }.
 * '?' prefix = optional. Returns a normalized args object. Throws Error on violation.
 */
export function checkArgs(toolName, args, spec) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: arguments must be an object`)
  }
  const out = {}
  for (const [key, rule] of Object.entries(spec)) {
    const optional = rule.startsWith('?')
    const type = optional ? rule.slice(1) : rule
    const v = args[key]
    if (v === undefined || v === null) {
      if (!optional) throw new Error(`${toolName}: missing required argument "${key}"`)
      continue
    }
    if (type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${toolName}: "${key}" must be an integer`)
    } else if (typeof v !== type) {
      throw new Error(`${toolName}: "${key}" must be a ${type}`)
    }
    out[key] = v
  }
  return out
}

/** Build the tool definition consumed by the MCP adapter in server.js. */
export function defTextTool({ name, description, parameters, execute }) {
  return { name, description, parameters, execute }
}
