import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv, SCRUB_ALLOWED_ENV_KEYS, SENSITIVE_ENV_PATTERN, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/**
 * Minimal concrete service: a hand-built handle. The seam is spawn-only —
 * defaulting, shell semantics, and deadlines belong to callers — so this stub
 * is all an implementation owes the abstract class.
 */
class StubSubprocessRuntime extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> {
    return `/bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const read: SubprocessOutputRead = { text: '', nextOffset: 0, lossy: false }
    const collected = spec.stdio.stdout !== 'pipe' && spec.stdio.stdout !== 'inherit'
      ? { stdout: { readFrom: () => read } }
      : {}
    return {
      pid: spec.argv.length,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

describe('SubprocessRuntime seam', () => {
  it('a concrete subclass registers as ctx.subprocess and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    const handle = ctx.subprocess.spawn({
      argv: ['true'],
      cwd: '/stub',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: 'inherit' },
      graceMs: 1,
    })
    expect(handle.pid).toBe(1)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })

  it('loading a second implementation throws (one subprocess service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    class SecondService extends StubSubprocessRuntime {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "subprocess" has been registered/)
  })

  it('scrubbedParentEnv drops credential-shaped and DSH_ names (case-insensitively) but keeps PATH', () => {
    process.env.DSH_SCRUB_PROBE = 'stale'
    process.env.dsh_scrub_probe_lower = 'stale'
    process.env.SCRUB_PROBE_TOKEN = 'secret'
    process.env.SCRUB_PROBE_PASSWORD = 'secret'
    process.env.SCRUB_PROBE_PLAIN = 'visible'
    try {
      const env = scrubbedParentEnv()
      expect(env.DSH_SCRUB_PROBE).toBeUndefined()
      expect(env.dsh_scrub_probe_lower).toBeUndefined()
      expect(env.SCRUB_PROBE_TOKEN).toBeUndefined()
      expect(env.SCRUB_PROBE_PASSWORD).toBeUndefined()
      expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.DSH_SCRUB_PROBE
      delete process.env.dsh_scrub_probe_lower
      delete process.env.SCRUB_PROBE_TOKEN
      delete process.env.SCRUB_PROBE_PASSWORD
      delete process.env.SCRUB_PROBE_PLAIN
    }
  })

  it('scrubbedParentEnv keeps names that merely contain a credential word and drops whole-segment shapes', () => {
    process.env.TOKENIZERS_PARALLELISM = 'false'
    process.env.KEYCLOAK_HOST = 'internal.example'
    process.env.GPG_KEY = 'secret-shaped'
    process.env.SCRUB_PROBE_SECRET_VALUE = 'secret'
    try {
      const env = scrubbedParentEnv()
      // The credential word must be its own underscore-delimited segment.
      expect(env.TOKENIZERS_PARALLELISM).toBe('false')
      expect(env.KEYCLOAK_HOST).toBe('internal.example')
      expect(env.GPG_KEY).toBeUndefined()
      expect(env.SCRUB_PROBE_SECRET_VALUE).toBeUndefined()
    } finally {
      delete process.env.TOKENIZERS_PARALLELISM
      delete process.env.KEYCLOAK_HOST
      delete process.env.GPG_KEY
      delete process.env.SCRUB_PROBE_SECRET_VALUE
    }
  })

  it('scrubbedParentEnv admits allowlisted names case-insensitively', () => {
    process.env.tokenizers_parallelism = 'false'
    try {
      expect(scrubbedParentEnv().tokenizers_parallelism).toBe('false')
    } finally {
      delete process.env.tokenizers_parallelism
    }
  })

  it('the anchored pattern spares containment-only names, and the allowlist records the exception', () => {
    expect(SENSITIVE_ENV_PATTERN.test('TOKENIZERS_PARALLELISM')).toBe(false)
    expect(SENSITIVE_ENV_PATTERN.test('KEYCLOAK_HOST')).toBe(false)
    expect(SENSITIVE_ENV_PATTERN.test('DEEPSEEK_API_KEY')).toBe(true)
    expect(SENSITIVE_ENV_PATTERN.test('MY_SECRET_VALUE')).toBe(true)
    expect(SENSITIVE_ENV_PATTERN.test('PASSWORD_FILE')).toBe(true)
    expect(SCRUB_ALLOWED_ENV_KEYS.has('TOKENIZERS_PARALLELISM')).toBe(true)
    expect(SCRUB_ALLOWED_ENV_KEYS.has('DSH_SESSION_ID')).toBe(false)
  })
})
