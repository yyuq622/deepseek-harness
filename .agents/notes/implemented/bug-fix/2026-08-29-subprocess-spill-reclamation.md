# Agent Note: Subprocess spill file reclamation

Status: implemented

English | [中文](2026-08-29-subprocess-spill-reclamation.zh.md)

## Problem

Every over-limit `bash`/`pwsh` output stream wrote a permanent spill file into the process's private OS-temp directory, and nothing ever deleted one. Each file is bounded by `maxSpillBytes` (64 MiB by default), but the count is unbounded: one file per overflowing stream, per command, forever. A long-lived process — the gateway, the ACP server — accumulated files for its whole uptime, and the process's `mkdtemp` directory itself was never removed. The provider README documented the accumulation as a known limitation.

Deletion could not simply happen when a command finished. A spill path is advertised to the model — in a truncated foreground result ("full output: …") and in lossy background reads — and the model may follow it in a later turn with the `read` or `grep` tools. Deleting at settlement, or when the executor finished reading, would advertise paths that no longer resolve.

## Decision

Spill files now have a three-part lifecycle, each part owned by the layer that can safely make the call:

| Part | Owner | Mechanism |
|---|---|---|
| Registry | `dsh-subprocess-local` runtime | `onSpillFileCreated` reports every created file; disposal unlinks the ones still tracked |
| Process-exit reclaim | `dsh-subprocess-local` spawn layer | The synchronous `process.on('exit')` phase removes the whole private spill directory (`removeProcessSpillDir`) |
| Foreground handoff | `dsh-shell` executor over `ctx.spillStore` | `retainSpillOutput` persists the raw file into the owning session's store, then deletes it; the result advertises the store locator |

Foreground handoff: the tool layer resolves spill ownership from the calling session (`ShellSpillContext` — session id, tool name, call id) onto `ShellExecRequest.spillContext`; the executor carries it through `resolve()` verbatim and, when a settled foreground stream has a spill path, `retainSpillOutput` saves the full text through `ctx.spillStore.saveText()` under the session's namespace and removes the raw file before `run()` resolves. The model-facing locator is therefore session-owned and subject to the store's own retention (the local backend's startup sweep), while the raw temp file is gone within the same command.

Background processes and ownership-free callers (headless plugin use, a composition without a spill store) keep executor-managed raw files. Their paths may surface in a read at any moment, so they are reclaimed at subprocess disposal or the process-exit phase, not per command. Every handoff failure — an unreadable raw file, a storage fault, a failed removal — is contained: the executor logs a warning and keeps advertising the raw path, which the runtime registry still owns.

## Alternatives considered

**Delete at handle settlement, once the executor has read the output.** Rejected: "the consumer finished reading" is not observable at the subprocess layer, and the model is a consumer whose reads come later. Settlement-time deletion breaks every advertised path the model has not followed yet.

**Migrate the subprocess collector to `ctx.spillStore` wholesale.** Rejected: the collector streams bytes under a live memory cap, while the spill seam is a save-complete-text contract. The executor-level handoff keeps streaming semantics where they belong and still gives owned foreground output a session-backed locator. This is the bash normalization the [tool output spill policy note](../architecture/2026-07-08-tool-output-spill-files.md) deferred.

**Track spill files per handle and delete on handle disposal.** Rejected: a background handle lives exactly as long as its paths must stay resolvable, so a per-handle boundary would delete files while the job runtime may still hand them to the model; the process-lifetime registry with a disposal/exit reclaim matches the advertisement window.

## Consequences

Temp accumulation is now bounded to files whose advertised paths can still be followed: zero for owned foreground output, exactly the executor-managed set for background and ownership-free runs, reclaimed at disposal and at process exit. The runtime's registry grows by one map entry (a path string) per created spill file — metadata, not file bodies.

Residual exposure: a process killed outside Node's synchronous exit phase (SIGKILL, fatal crash, power loss) leaves one private `mkdtemp` directory behind, matching the provider's existing in-process-cleanup limitation; the OS temp cleaner is the backstop, as for any temp artifact.

## Testing

- `dsh-bash-local` drives the sentinel end to end: three over-limit foreground commands with resolved ownership each persist through the store and leave zero `dsh-subprocess-*` files in the executor's temp area; an ownership-free run keeps its raw file (the allowed retention).
- `dsh-pwsh-local` mirrors the handoff sentinel (one over-limit command, zero leftovers).
- `dsh-subprocess-local` pins the registry: the runtime holds one spill file per over-limit command until disposal reclaims all of them, reports every creation through the internals hook, and `removeProcessSpillDir` really removes the default directory while a later spawn recreates it.
