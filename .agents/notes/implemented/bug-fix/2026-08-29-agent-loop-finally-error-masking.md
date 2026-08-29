# Agent Note: Agent-loop finally blocks never mask the in-flight error

Status: implemented

English | [中文](2026-08-29-agent-loop-finally-error-masking.zh.md)

## Problem

The turn driver closes its durable boundaries (`step/end`, `turn/end`) inside `finally` blocks, so they also run while a step or turn failure is propagating. A persistence fault in such an append replaced the in-flight error: an `LlmError` carrying provider facts surfaced as an `UNKNOWN` append fault, the `turn/end` reason recorded the wrong cause, and `agent/error` reported the durability fault as if it were the turn's outcome.

## Decision

The reporting half of `throwError` is split into `reportError` (emit only). Each boundary `finally` wraps its append and classifies the outcome:

- With an error already in flight (a flag the `catch` sets), the append fault is reported through `agent/error` on its own and the original error keeps propagating — the fused dispatcher contains listener failures, so reporting from an unwind path cannot mask anything.
- Without one, the append fault IS the boundary's outcome and takes the full `throwError` path, exactly as before.

## Alternatives considered

**Log the suppressed fault instead of emitting.** Rejected: `agent/error` is the structured surface consumers already observe; a log line would hide the durability fault from the same observers that see the turn outcome. The emit is safe because the fused dispatcher contains per-listener failures by contract.

**Move the boundary appends out of `finally`.** Rejected: the boundaries must close on every exit — that is the crash-tail guarantee the log format relies on.

## Consequences

The root cause survives the overlay of a persistence fault, in the `agent/error` stream and in the `turn/end` reason alike. A consumer can now observe two `agent/error` events for one turn — the original failure plus the boundary persistence fault — which is the honest shape: the durable log is genuinely missing that boundary event.

## Testing

`loop.spec` drives the overlay through a failing `session.append`: a step failure plus a `step/end` fault keeps `provider exploded` as the turn outcome (and the next turn persists normally once persistence is restored); a healthy turn losing both boundaries reports each fault and leaves no `turn/end`; a healthy turn losing only `turn/end` surfaces the append fault as the turn error.
