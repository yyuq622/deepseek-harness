/**
 * Local Service Provider for the bash capability seam over the subprocess
 * capability seam. Public commands run as `bash -c` in a managed process group spawned
 * through `ctx.subprocess`; the foreground/background lifecycle, deadlines and
 * cause classification, and the model-facing stdout/stderr merge for
 * background reads live on the shared local executor base. This executor
 * owns the shell identity: the `bash -c` argv and the terminal environment
 * overrides. Execution policy belongs in `tools/pre-execute` or a
 * sandboxing executor.
 * @module @deepseek-ai/dsh-bash-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalShellExecutorBase, assertLocalShellConfig } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'

/**
 * Model-friendly environment overrides: disable colors, pagers, and
 * interactive terminal features that would garble tool output (the same set
 * Codex hardcodes; Claude Code achieves it via TERM=dumb). Bash-tool policy —
 * merged first into the spawn's explicit env, so a trusted caller's own entry
 * still wins; the subprocess service applies its credential scrub independently.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config; matches OpenCode's 3s). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (the `maxSpillBytes` config). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

/**
 * Reject a resolved section this executor could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound `graceMs` has to
 * fit, so a stored value is refused where it is written instead of failing at
 * the next command.
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableBashConfig(config: Config): void {
  assertLocalShellConfig('bash-local', config as ResolvedConfig)
}

/**
 * Local bash executor over `ctx.subprocess`. Bounded output, spill files, and
 * process-group SIGTERM→SIGKILL escalation are the subprocess service's
 * mechanics; this executor supplies their configured budgets per spawn, so a
 * still-running background process stays managed (killed and joined at
 * composition teardown) even across an executor reload.
 */
export class LocalBashExecutor extends LocalShellExecutorBase<ResolvedConfig> {
  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  })

  constructor(ctx: Context, config: Config) {
    // Schemastery fills these fields before construction; the type does not encode that step.
    super(ctx, {
      label: 'bash-local',
      configSchema: LocalBashExecutor.Config,
      config: config as ResolvedConfig,
      assertServiceable: assertServiceableBashConfig,
    })
  }

  protected override readonly envOverrides = ENV_OVERRIDES

  protected override argv(spec: ShellExecSpec): string[] {
    return ['bash', '-c', spec.command]
  }
}

export default LocalBashExecutor
