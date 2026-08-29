# Agent Note: Configurable JSONL fsync strategy

Status: implemented

English | [中文](2026-08-29-jsonl-fsync-strategy.zh.md)

## Problem

The JSONL backend fsynced every appended batch before the append resolved. Durability was maximal, but a streaming session pays one fsync per write batch — hundreds per turn on a token stream — and the cost showed up as append latency on slow disks. Deployments that only need completed turns to survive a crash had no way to trade the per-batch sync away.

## Decision

The backend takes a `sync` config with two strategies:

- `'batch'` (default): every appended batch is fsynced before the append resolves — today's behavior, byte for byte.
- `'turn'`: only batches that close a `turn/end` boundary are fsynced — the turn is the log's commit/replay boundary, so a completed turn stays durable while the batches between boundaries ride the OS writeback. A crash can lose the tail of the in-flight turn, which surfaces as a torn tail and is recovered on the next open by the existing torn-tail machinery; completed turns never regress.

The rollback protocol is unchanged in both strategies: a write or sync failure rolls the file back to its prior length, because the coordinator's unchanged cursor retries the batch.

## Alternatives considered

**Time-based fsync (fsync at most once per N milliseconds).** Rejected: the window a crash can lose becomes unbounded by any log-semantic line, and the knob invites tuning blind; a turn boundary is a meaningful commit line the log already carries.

**Sync on every event instead of every batch.** Rejected: strictly more fsyncs than the batch default with no added durability — the batch is the write unit.

**Make the strategy per-session rather than per-backend.** Rejected: durability is a deployment property of the storage root, not of individual sessions; one backend, one strategy keeps the format and the torn-tail guarantees uniform.

## Consequences

`'turn'` removes all but one fsync per turn from high-volume streams at the cost of a bounded crash window inside the in-flight turn — recovered by the same torn-tail machinery, never corrupting the committed prefix. The default `'batch'` behavior is unchanged, so existing deployments keep their durability without touching config.

## Testing

`zstd.spec` drives both strategies through a FileHandle `sync` spy: under `'batch'` every appended batch syncs; under `'turn'` a boundary-free batch syncs nothing and a `turn/end` batch syncs exactly once, with the appended events loading back in full.
