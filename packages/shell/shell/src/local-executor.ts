/**
 * Local shell executor skeleton over the `ctx.subprocess` seam: the
 * foreground/background lifecycle shared by the bash and PowerShell
 * executors — settings-backed config, request resolution with deadline
 * fusion, bounded collect with the foreground spill handoff, the background
 * read merge, and the settlement hook the sandboxing subclasses extend.
 *
 * Subclasses supply the shell identity: the argv for a resolved spec
 * ({@link LocalShellExecutorBase.argv}), the terminal environment overrides,
 * and a diagnostics label. Termination, cleanup, and spill reclamation are
 * the subprocess seam's mechanics; this skeleton drives the seam and owns no
 * process mechanics of its own.
 * @module @deepseek-ai/dsh-shell/local-executor
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ShellExecutor, SHELL_SETTINGS_NAMESPACE } from './executor.ts'
import { retainSpillOutput } from './spill.ts'
import type {
  CollectedOutput, ShellExecRequest, ShellExecSpec, ShellProcess, ShellProcessRead,
  ShellRunResult,
} from './types.ts'

/** The config fields every local shell executor resolves and shares. */
export interface LocalShellExecutorConfig {
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

/** The shape after schemastery applied the defaults (`cwd` has none). */
export interface ResolvedLocalShellConfig {
  cwd?: string
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  maxSpillBytes: number
  graceMs: number
}

/**
 * Reject a resolved config a local executor could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound `graceMs` has
 * to fit, so a stored value is refused where it is written instead of failing
 * at the next command.
 * @param label - the executor's diagnostics label (`bash-local`, `pwsh-local`).
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertLocalShellConfig(label: string, config: ResolvedLocalShellConfig): void {
  const assertPositiveFinite = (name: string, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label}: ${name} must be a positive finite number`)
    }
  }
  assertPositiveFinite('timeoutMs', config.timeoutMs)
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs)
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes)
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes)
  assertPositiveFinite('graceMs', config.graceMs)
  if (config.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${label}: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Constructor facts the concrete executors supply to the shared skeleton. */
export interface LocalShellExecutorInit<C extends ResolvedLocalShellConfig> {
  /** Diagnostics label prefixing this executor's errors (`bash-local`, `pwsh-local`). */
  label: string
  /** The settings schema: the composition entry merged with the live section. */
  configSchema: z<C>
  /** The composition entry with Schemastery's defaults applied. */
  config: C
  /** The serviceability guard the settings section re-runs on every committed change. */
  assertServiceable(config: C): void
  /** Re-judge facts derived from the config source after an attach or change. */
  onChange?: () => void
}

/**
 * The local shell executor skeleton over `ctx.subprocess`. Bounded output,
 * spill files, process-group signalling, and their termination semantics are
 * the subprocess service's mechanics; this skeleton supplies their configured
 * budgets per spawn, drives the foreground and background lifecycles, and
 * hands truncated foreground streams to the owning session's spill store.
 */
export abstract class LocalShellExecutorBase<C extends ResolvedLocalShellConfig> extends ShellExecutor {
  static inject = ['subprocess']

  private source: () => C

  /** Diagnostics label prefixing this executor's errors. */
  protected readonly label: string

  /** Validated config (schemastery applied the defaults before construction). */
  protected get config(): C {
    return this.source()
  }

  protected constructor(
    ctx: Context,
    init: LocalShellExecutorInit<C>,
  ) {
    super(ctx)
    init.assertServiceable(init.config)
    this.label = init.label
    this.source = () => init.config
    installSettingsSection(ctx, SHELL_SETTINGS_NAMESPACE, init.configSchema, init.config, {
      validate: init.assertServiceable,
      setSource: (current) => {
        this.source = current as () => C
      },
      onChange: () => {
        init.onChange?.()
      },
    })
  }

  /** The terminal environment overrides merged ahead of the caller's env; the
   * subprocess service scrubs the ambient base and layers dshEnv after. */
  protected abstract readonly envOverrides: Readonly<Record<string, string>>

  private assertPositiveFinite(name: string, value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${this.label}: ${name} must be a positive finite number`)
    }
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`. The tool layer calls
   * this before run/start, so those methods receive explicit values and never
   * re-default.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      `${this.label}: request.timeoutMs`,
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    this.assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      // Carry stdin/ordinary env/trusted dshEnv through verbatim — optional,
      // no config default. The subprocess service owns the scrub and merge order.
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      // Foreground spill ownership, resolved by the tool layer; carried
      // through verbatim (no defaulting) and ignored by `start()`.
      ...request.spillContext !== undefined ? { spillContext: request.spillContext } : {},
      // Carry a sandbox policy through verbatim: this executor never
      // confines, so the field is inert here (the seam contract) — a
      // sandboxing subclass overrides resolve() to stamp its default instead.
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** Map one resolved spec plus its argv onto a fully-specified subprocess spawn. */
  private spawnSpec(
    spec: ShellExecSpec,
    argv: readonly string[],
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      // One explicit env map for the seam, layered so the trusted dshEnv
      // snapshot beats both the caller's env and the terminal overrides; the
      // subprocess service merges the whole map after its ambient scrub.
      env: { ...this.envOverrides, ...spec.env, ...spec.dshEnv },
    }
  }

  /** The collect-mode readers the executor itself requested (present by construction). */
  private collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error(`${this.label}: subprocess implementation dropped a requested collect stream`)
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  /**
   * Project a settled collect-mode reader into the final CollectedOutput
   * shape, handing a truncated stream to the owning session's spill store
   * when the request resolved spill ownership. The handoff completes before
   * `run()` resolves, so a foreground result never advertises a raw
   * subprocess temp path; without ownership (headless plugin callers) or a
   * mounted store the raw path stays, owned by subprocess disposal and the
   * process-exit cleanup.
   */
  private async finalOutput(reader: SubprocessOutputReader, spec: ShellExecSpec, label: string): Promise<CollectedOutput> {
    const read = reader.readFrom(0)
    if (read.spillPath === undefined) {
      return { text: read.text, truncated: read.lossy }
    }
    const context = spec.spillContext
    const retained = context === undefined
      ? undefined
      : await retainSpillOutput({
        store: this.ctx.get('spillStore'),
        context,
        rawPath: read.spillPath,
        label,
        warn: (message) => { this.ctx.logger.warn(message) },
      })
    return { text: read.text, truncated: read.lossy, spillPath: retained ?? read.spillPath }
  }

  /**
   * Run a command in the foreground through this executor's argv.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the outcome; nonzero exits, timeout kills, and abort kills
   *   resolve with a descriptive result rather than reject.
   */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.runArgv(spec, this.argv(spec))
  }

  /**
   * Run an explicit argv with the foreground lifecycle, environment, output,
   * timeout, and cancellation semantics of this executor. Subclasses use this
   * after replacing the public command's shell argv at an execution boundary.
   * @param spec - resolved execution settings and caller-owned command metadata.
   * @param argv - exact executable and arguments to hand to `ctx.subprocess`.
   * @returns the settled foreground result with collected output and cause facts.
   */
  protected async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = this.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
    const aborted = d.signal.aborted && !timedOut
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: await this.finalOutput(collected.stdout, spec, 'stdout'),
      stderr: await this.finalOutput(collected.stderr, spec, 'stderr'),
    }
  }

  /**
   * Start a background process and return its handle immediately.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the live process handle (reads, kill, quiescence promise).
   */
  start(spec: ShellExecSpec): ShellProcess {
    return this.startArgv(spec, this.argv(spec))
  }

  /**
   * Start an explicit argv with the background lifecycle, environment, output,
   * cancellation, and process-tree ownership semantics of this executor.
   * Subclasses use this after replacing the public command's shell argv at an
   * execution boundary.
   * @param spec - resolved execution settings and caller-owned command metadata.
   * @param argv - exact executable and arguments to hand to `ctx.subprocess`.
   * @returns the live background handle; spawn rejection settles it as killed.
   */
  protected startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    // Background runs ignore timeoutMs; callers stop them through kill() or spec.signal.
    // `spillContext` is deliberately ignored here: a background read may
    // advertise its spill path mid-run, and that path must stay resolvable
    // until subprocess disposal (or process exit) reclaims the file.
    const running = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, this.config.maxOutputBytes, spec.signal))
    const collected = this.collected(running)

    // A spawn failure produces no process output, so the subprocess service has nothing
    // to buffer; the note is delivered exactly once through the read path.
    let spawnFailureNote: string | undefined
    const consumeSpawnFailure = (): string => {
      const note = spawnFailureNote ?? ''
      spawnFailureNote = undefined
      return note
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        // Any signal termination is killed, including a command signaling itself.
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
      }, (error: unknown) => {
        // Background spawn failures settle as killed and surface through the read path.
        proc.status = 'killed'
        spawnFailureNote = `spawn failed: ${String(error)}`
        this.onProcessDone(proc, spawnFailureNote, true, error)
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        // A failed spawn never produced process output, so the note and real
        // stderr text are mutually exclusive.
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        // Single newline between sections: stdout chunks usually end with one
        // already; add it only when missing.
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }

  /**
   * Settlement hook for subclasses that attach execution facts to a process.
   * Called after exit facts or spawn-failure output are stamped and before
   * {@link ShellProcess.done} resolves. The base implementation is intentionally
   * empty.
   * @param _proc - the settled process handle.
   * @param _stderr - the process's retained stderr tail used by subclasses for settlement classification.
   * @param _spawnFailed - whether the subprocess promise rejected before a process started.
   * @param _spawnError - the original spawn rejection reason, which may itself be undefined.
   */
  protected onProcessDone(_proc: ShellProcess, _stderr: string, _spawnFailed: boolean, _spawnError?: unknown): void {}
}
