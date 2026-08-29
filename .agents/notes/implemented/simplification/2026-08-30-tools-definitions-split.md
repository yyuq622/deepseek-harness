# Agent Note: Tools contract split

Status: implemented

English | [中文](2026-08-30-tools-definitions-split.zh.md)

## Problem

`dsh-tools`' `index.ts` had grown to ~1.9k lines carrying three unrelated concerns: the `ToolRuntime` service with its registry and execution pipeline, the public contract vocabulary (25 exported tool/execution types, canonical codes, and two error classes), and the pure snapshot/normalization helpers that vocabulary relies on. The contract surface — what every tool author and consumer reads first — was buried inside the service implementation.

## Decision

The contract vocabulary moved to `definitions.ts`: all 25 public tool/execution types and codes, the two error classes, and the pure helpers they use (`errorMessage`, `errorInfo`, `failureMessageFromContent`, `materializePresentation`, `projectionError`, `snapshotProjection`, `snapshotToolValue`, `createExecutionToken`). `index.ts` re-exports every moved public name unchanged — the package's export surface is identical — while the runtime imports its vocabulary from `definitions.ts` directly. `ToolRuntime`, `ToolLayer`, the plugin config, and the pipeline-local helpers (`fuseToolSignals`, `toolErrorResult`, the aborted-result builders) stay in `index.ts`; the `ptc`/`ts-types`/`py-types`/`presentation`/`json-schema` modules were already separate.

`definitions.ts` is a leaf: it imports nothing from the package, so `ptc.ts`, `schema.ts`, `testing.ts`, and `invariant.ts` keep importing the moved names through `index.ts` exactly as before.

## Alternatives considered

**Split the `ToolRuntime` class itself (registry vs pipeline files).** Deferred: the class's ~1.1k lines share private dispatch state and waterfall wiring; a class split is a design change to the most core package and needs its own verified pass, not a mechanical move.

**Move the vocabulary into the existing `types.ts`.** Rejected: `types.ts` owns the durable `tool/code-dispatch` event payload types; merging the contract vocabulary there would mix the public API with wire-event internals.

**Export the helpers through the package index.** Rejected: the helpers were module-private before; re-exporting them would widen the package surface in a refactor that must not change it.

## Consequences

The contract surface is readable in one 470-line file, and the service implementation sheds the vocabulary. The package's export surface, generated catalogs, and every consumer import are unchanged. Remaining large modules in this package: none — the split was the last index-level concern; the `ToolRuntime` class size is unchanged and remains the known concentration point.

## Testing

No new tests: this is a mechanical move with an unchanged export surface. The package's suites (registry, pipeline, PTC, schema, presentation) import the moved names through `@deepseek-ai/dsh-tools` and pass unchanged; `definitions.ts` is covered through those same suites (its helpers and types are exercised by every pipeline and schema test).
