# Agent Note: Local shell executor base

Status: implemented

English | [中文](2026-08-30-local-shell-executor-base.zh.md)

## Problem

`dsh-bash-local` and `dsh-pwsh-local` carried call-for-call mirrors of the same ~300-line executor skeleton — settings-backed config, request resolution with deadline fusion, bounded collect with the spill handoff, the foreground run, the background handle with its read merge, and the settlement hook — duplicated wholesale and pinned by jscpd ignore markers. Every lifecycle fix landed twice (the spill handoff and sync strategy both had to), and the mirror drift was one missed edit away.

## Decision

The shared skeleton now lives in the seam package as `LocalShellExecutorBase` (`dsh-shell/local-executor`), extending `ShellExecutor` and owning everything over `ctx.subprocess`: the settings-backed config source, `resolve()` with deadline fusion, `spawnSpec`, the collect readers, the foreground spill handoff, `runArgv`/`startArgv`, and the empty `onProcessDone` settlement hook the sandboxing subclasses extend. Subclasses supply only the shell identity — a diagnostics label, the settings schema, the serviceability guard, an optional settings-change hook, the terminal environment overrides, and the `argv` for a resolved spec.

`ShellExecutor` and `SHELL_SETTINGS_NAMESPACE` moved from the seam's `index.ts` into `executor.ts` so the base can extend the service without a module-evaluation cycle; the seam's index re-exports them unchanged, and `dsh-timeout` joined the seam's peers (the skeleton owns the deadline fusion). The subclass config shapes (`ResolvedConfig`) stay local to each package — the base reads them through the shared `ResolvedLocalShellConfig` structural type.

Termination and cleanup semantics were not rewritten: the skeleton drives `ctx.subprocess` exactly as the mirrors did, so the subprocess seam's identity-fenced sweeps, escalation, spill reclamation, and async deliveries are untouched.

## Alternatives considered

**Keep the twins and leave the mirror to jscpd.** Rejected: the ignore markers pinned ~300 duplicated lines that had already absorbed two behavior changes (the spill handoff and the fsync strategy) double-applied; a third lifecycle fix was a matter of time.

**Put the base in a new `dsh-shell-local` package.** Rejected: the seam package already owns the spill handoff and the settings namespace — the two provider-side facts the skeleton needs — so a sibling package would re-export them for no boundary gain.

**Extract at the tool layer instead (the parity note's deferred option).** Deferred there and here: the tool twins (`render.ts`/`background.ts`) remain mirrors; this extraction covers the executor layer only, and the tool-layer base still waits for its third dialect.

## Consequences

The two executors are thin: shell identity plus config. A lifecycle fix lands once, and the jscpd ignore markers are gone. The sandboxing subclasses keep their exact override surface (`resolve`, `run`/`start` with confined argv, `onProcessDone`), and the pwsh executor's settings-driven executable re-resolution moves to the base's `onChange` hook unchanged. One behavioral nuance, verified equivalent: the spawn spec now always copies the argv array (the pwsh mirror's defensive copy) — the seam types argv read-only, so the bash path is unchanged in effect.

## Testing

Both executor suites (`bash-local`, `pwsh-local`) are the equivalence tests: they assert the identical contract — foreground outcomes and cause classification, background reads and kill semantics, spill handoff, settings rotation — against each executor, and pass unchanged over the shared skeleton. The sandbox suites pin the subclass override surface (`runArgv`/`startArgv`/`onProcessDone`/`argv`) on both dialects.
