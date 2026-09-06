/**
 * toolkit.js — shared definitions for the remote text tools.
 *
 * The MCP adapter publishes and validates the JSON schemas through Zod.
 * checkArgs also protects direct callers of these reusable tools.
 */

/** Canonical output: one text block. */
export const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

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

/** Build a raw ToolDefinition with text output. */
export function defTextTool({ name, description, parameters, execute, timeoutMs }) {
  return {
    name,
    description,
    parameters,
    output: textOutput,
    timeoutMs,
    async execute(args, exec) {
      return execute(args, exec)
    },
  }
}
