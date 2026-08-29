/**
 * Service Definition for the `ctx.shell` capability seam, covering foreground commands and background process
 * handles. Job ids, ownership, polling, and notices belong to
 * `@deepseek-ai/dsh-jobs`, keeping executors independent of sessions.
 * @module @deepseek-ai/dsh-shell
 */

export { SHELL_SETTINGS_NAMESPACE, ShellExecutor } from './executor.ts'
export { ShellExecutor as default } from './executor.ts'
export { LocalShellExecutorBase, assertLocalShellConfig } from './local-executor.ts'
export type {
  LocalShellExecutorConfig,
  LocalShellExecutorInit,
  ResolvedLocalShellConfig,
} from './local-executor.ts'
export { DSH_ENV_PREFIX } from './types.ts'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
  ShellSpillContext,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { parseExitStatus } from './render.ts'
export type { ParsedExitStatus } from './render.ts'
export { retainSpillOutput } from './spill.ts'
export type { RetainSpillOutputParams } from './spill.ts'
