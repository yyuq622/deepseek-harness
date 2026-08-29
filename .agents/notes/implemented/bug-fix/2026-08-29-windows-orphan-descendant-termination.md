# Agent Note: Windows orphan descendant termination

Status: implemented

English | [中文](2026-08-29-windows-orphan-descendant-termination.zh.md)

## Problem

On POSIX, `terminate()` signals the detached process group, so it reaches every in-group member — including descendants that outlive the direct child. On Windows, termination was a blind `taskkill /PID <pid> /T /F`, which requires the root to still be alive. A root that exited naturally (exit 0) while detached descendants kept running made `treeAlive()` report false, so `terminate()` returned without touching the tree: the descendants ran on forever. The grace escalation was cancelled at direct-child settlement for the same reason, despite a comment claiming it survived it. Cancelling a bash command that had spawned a background process left that process running on Windows while the identical scenario was reaped on POSIX.

## Decision

Windows termination is now an identity-fenced sweep owned by `dsh-subprocess-local`:

- At spawn, the root's creation-time identity is captured from the process table (`GetProcessTimes` via the koffi bindings).
- Every termination tier — `terminate()`'s first sweep and the post-grace re-sweep, `terminateForHostExit()`, and the abort listener — runs the same sweep. A live root whose identity still matches is terminated with `taskkill /T /F` (the tree kill, as before). Once the root is gone — including an exited root whose state stays readable through held handles, distinguished by the wait state — the sweep walks the process table from the root pid's children (descendants keep their `th32ParentProcessID` link to the absent root) and force-terminates each survivor, re-verifying its creation identity immediately before the kill so a candidate that exited and whose pid was reused is skipped, not signalled.
- `hasLiveWork` answers the same question without terminating: the wait path uses it to release the post-grace escalation (and the ref'd timer that holds the event loop) as soon as nothing is left reachable, instead of at direct-child settlement.
- Arming follows the sweep: a tier that terminated something keeps the re-sweep committed; a tier that found nothing alive — or a root pid whose occupant no longer matches — arms nothing.
- POSIX paths are unchanged: the group probe, the direct-child fallback, and the group-liveness gate on `kill()` keep their exact semantics. Without an available sweep (a non-Windows host running win32-semantics tests), the legacy pid-targeted fallback preserves the old boundary.

An unreadable root identity at spawn falls back to pid-targeted termination of a live root — today's behavior — rather than refusing to terminate.

## Alternatives considered

**Keep `taskkill /T` and accept the gap.** Rejected: the orphan leak is the defect; on Windows the tool runs on the primary development platform, so the parity gap was observable on every cancelled command that daemonized a child.

**Extend the wait boundary: make `waitForExit` await descendant death.** Rejected: it changes the documented wait contract, and an unkillable descendant would hang the wait; the wait stays at the direct child while the sweep owns reclamation.

**Kill the parent-link chain without identity fencing.** Rejected: a reused root pid's children are indistinguishable from the exited root's orphans by parent link alone; the per-candidate creation-identity re-verification and the root-identity match are what make the sweep safe to aim.

**Job Objects (`AssignProcessToJobObject`) for true tree semantics.** Rejected for now: it requires handle injection into every child and breakaway handling, a much larger substrate change; the parent-link sweep with identity fencing closes the gap within the current primitives. Revisit if a descendant that breaks its parent link (none exists on Windows today) becomes a real escape.

## Consequences

Windows termination now reaches the same descendants POSIX group signalling reaches, so cancelling a command reaps its process tree on both platforms. Each termination tier costs one Toolhelp32 snapshot plus one process-state read per candidate, bounded by the teardown window. Residual escapes, shared with the POSIX probe design: a descendant spawned after the final sweep, and orphans made indistinguishable by a double-reused root pid — both are skipped, never mis-aimed. The sweep also fixes a latent hazard in `terminateForHostExit()`, which previously force-killed the root pid blind and could have hit a reused pid at host exit.

## Testing

- `windows-inspector` unit tests pin the sweep contract on any host: live-root kill, reused-root refusal, the unreadable-identity fallback, children-first orphan sweeps, the held-handle exited root, the snapshot-to-kill reuse skip, and read-only `hasLiveWork`.
- `spawn` wiring tests (injected sweep, injected platform) pin the spawn-side decisions: identity captured at spawn, tier 1 plus exactly one post-grace re-sweep, no arming for an absent tree, the wait path never terminating, and escalation release when the wait observes no live work.
- A real-Windows integration test spawns a root that exits naturally with a surviving descendant (pid written to a file) and asserts `terminate()` reaps the descendant through the real koffi-backed table.
