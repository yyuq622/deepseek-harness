/**
 * Local PowerShell Service Provider for the bash capability seam. Each command runs
 * as `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` in a managed
 * process spawned through `ctx.subprocess`; the foreground/background
 * lifecycle, deadlines and cause classification, and the model-facing
 * stdout/stderr merge for background reads live on the shared local executor
 * base. This executor owns the shell identity: executable resolution, the
 * `pwsh -Command` argv with UTF-8 output pinning, and the terminal
 * environment overrides.
 *
 * The command string is passed as ONE argv element to `-Command`: PowerShell
 * itself parses the text, and no intermediate shell exists, so there is no
 * shell-quoting layer to escape (the `bash -c` string domain has no
 * equivalent here). Native Win32 paths (`C:\...`) pass through unchanged.
 *
 * @module @deepseek-ai/dsh-pwsh-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalShellExecutorBase, assertLocalShellConfig } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import { resolvePwshPath } from './resolve.ts'

/**
 * Model-friendly environment overrides for PowerShell: disable colors and
 * pagers that would garble tool output. `TERM=dumb` is a POSIX concept and is
 * deliberately absent; `NO_COLOR` is honored by modern pwsh renderers.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/**
 * UTF-8 output pinning prepended to every command. The subprocess collector
 * decodes output bytes as UTF-8, but Windows PowerShell 5.1 (the last-resort
 * executable fallback) writes the console/OEM code page by default, which
 * garbles non-ASCII output; pwsh 7 defaults to UTF-8 and is unaffected. The
 * statements ride on line 1 after `; ` separators so PowerShell error line
 * numbers stay accurate.
 */
export const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config). */
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
  /**
   * Explicit pwsh executable. When omitted, well-known Windows install
   * locations and PATH entries are probed in order (PowerShell 7 install,
   * PATH entries such as the Microsoft Store install, then Windows
   * PowerShell 5.1), falling back to a bare `pwsh` resolved through PATH.
   */
  pwshPath?: string
}

/** The shape after schemastery applied the defaults (cwd/pwshPath have none). */
type ResolvedConfig = Required<Omit<Config, 'cwd' | 'pwshPath'>> & Pick<Config, 'cwd' | 'pwshPath'>

// Resolution lives in its own dependency-free module so the repository's
// coverage-gate probe shares the exact definition the suites use.
export { candidatePwshPaths, resolvePwshPath } from './resolve.ts'

/**
 * Reject a resolved section this executor could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound `graceMs` has
 * to fit, so a stored value is refused where it is written instead of failing
 * at the next command.
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceablePwshConfig(config: Config): void {
  assertLocalShellConfig('pwsh-local', config as ResolvedConfig)
}

/**
 * Local PowerShell executor over `ctx.subprocess`. Bounded output, spill
 * files, and process-tree termination are the subprocess service's mechanics;
 * this executor supplies their configured budgets per spawn.
 */
export class PwshLocalExecutor extends LocalShellExecutorBase<ResolvedConfig> {
  static Config: z<Config> = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
    pwshPath: z.string(),
  })

  /** The declared executable the current {@link pwshPath} was resolved from. */
  private declaredPwshPath: string | undefined

  /** The pwsh executable resolved from the current config. */
  private resolvedPwshPath: string

  /** The pwsh executable every command runs through. */
  get pwshPath(): string {
    return this.resolvedPwshPath
  }

  constructor(ctx: Context, config: Config) {
    // Schemastery fills these fields before construction; the type does not encode that step.
    const entry = config as ResolvedConfig
    super(ctx, {
      label: 'pwsh-local',
      configSchema: PwshLocalExecutor.Config,
      config: entry,
      assertServiceable: assertServiceablePwshConfig,
      onChange: () => { this.refreshPwshPath() },
    })
    this.declaredPwshPath = entry.pwshPath
    this.resolvedPwshPath = resolvePwshPath(entry.pwshPath)
  }

  /** Re-resolve the executable when a committed settings change declares a different one. */
  private refreshPwshPath(): void {
    const declared = this.config.pwshPath
    if (declared === this.declaredPwshPath) return
    this.declaredPwshPath = declared
    this.resolvedPwshPath = resolvePwshPath(declared)
  }

  protected override readonly envOverrides = ENV_OVERRIDES

  /**
   * The pwsh invocation argv for one resolved spec — the argv-level seam a
   * confining subclass wraps through `ctx.sandbox.confine` (the pwsh twin of
   * `dsh-bash-local`'s `runArgv`/`startArgv` hooks; see
   * `@deepseek-ai/dsh-pwsh-sandbox`).
   */
  protected override argv(spec: ShellExecSpec): string[] {
    return [this.pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${spec.command}`]
  }
}

export default PwshLocalExecutor
