# Agent Note: Asynchronous process termination and probing

Status: implemented

English | [中文](2026-08-29-async-process-termination.zh.md)

## Problem

Every termination tier and probe blocked the event loop on synchronous process operations. On Windows, each `terminate()` tier ran `taskkill /T /F` through `spawnSync` — a tree walk that freezes the loop for tens to hundreds of milliseconds, so a tool cancellation stalled streaming output, heartbeats, and concurrent work. On Linux, the exit observer's per-tick `/proc` walk ran `readdirSync` plus a `readFileSync` per entry inside the teardown wait.

## Decision

Deliveries and probes are asynchronous everywhere a caller can observe the outcome, and synchronous only where no await exists:

- The Windows sweep's taskkill deliveries spawn asynchronously (`taskkillTreeAsync`) and the sweep resolves once they have been delivered. `terminate()`'s tiers fire the sweep and, on Windows, arm the post-grace re-sweep from the tier's outcome under an in-flight latch; the abort path fires without awaiting. The outcome stays observable through `done` and the exit observer — the cancellation contract is unchanged, only the delivery stops blocking.
- The sweep keeps a synchronous form (`sweepSync`) for the host-exit phase alone, which cannot await: the same identity-fenced targets delivered through the synchronous taskkill, per the no-promises-or-timers host-exit contract.
- The Linux `/proc` walk reads asynchronously (`readDirAsync`/`readFileAsync` internals); the exit observer polls through an async probe that keeps the zombie-refinement semantics. `treeAlive()` — the cheap guard the POSIX `kill()` tiers and the Windows path use — drops the per-call scan: signalling a zombie-only group is a contained no-op (zombies ignore signals), so the guard's outcome is unchanged without the scan.
- The terminal inspector's `signalGroup`/`signalProcess` fire the asynchronous delivery when available; the terminal teardown's re-sweep observes actual absence, which is the quiescence await.

The internals interfaces take the async operations as optional members (`taskkillAsync`, and the async fs reads on the /proc path), so synchronous test fakes keep working — the sweep and inspector fall back to the synchronous form, whose delivery in a fake is instant.

## Alternatives considered

**Await the sweep in every caller.** Rejected: `terminate()` and the grace-timer callback run in synchronous cancellation contexts; making them async would ripple the await through every consumer for no observable gain — `done` and the exit observer already observe the real outcome (the processes dying), which is stronger than awaiting the taskkill process's own exit.

**Offload the synchronous taskkill and /proc walk to a worker thread.** Rejected: a spawned taskkill is already an independent OS process, so the delivery is off the loop the moment `spawn` returns; a worker would add the koffi/serialization surface without changing what is observed.

**Drop the Linux zombie refinement from the exit observer too.** Rejected: a zombie-only group answers `kill(0)` but can never reach quiescence, so the observer must read it as absent or the teardown wait would hang; the refinement moves to the async probe instead of being removed.

## Consequences

A Windows cancellation tier never freezes the event loop on taskkill's tree walk, and the Linux exit observer's per-tick `/proc` walks stop blocking. The post-grace re-sweep is armed after the first delivery completes rather than at tier initiation — a bounded shift that starts the grace where the kill was actually delivered. The host-exit phase keeps its synchronous, identity-fenced sweep; nothing about quiescence or the wait boundary changes.

## Testing

The sweep contract tests await the now-async `sweep`; the spawn wiring tests observe tier delivery and arming through `vi.waitFor` (tier 1, exactly one post-grace re-sweep, no arming for an absent tree, release when the wait observes no live work); the Linux probe tests resolve through the async walk; the legacy injected-platform tests keep the synchronous fallback boundary.
