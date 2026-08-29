/**
 * Foreground spill handoff for shell executors: move one subprocess spill
 * file into the owning session's spill store so the advertised locator
 * outlives the command, then remove the raw file. Background processes do not
 * hand off — their spill paths may surface in mid-run reads that must stay
 * resolvable until subprocess disposal.
 * @module dsh-shell/spill
 */

import { readFile, rm } from 'node:fs/promises'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import type { ShellSpillContext } from './types.ts'

/** Inputs for one foreground spill handoff. */
export interface RetainSpillOutputParams {
  /** The session's spill backend; `undefined` (composition without one) keeps the raw file. */
  store: SpillStore | undefined
  /** The resolved spill ownership from the request. */
  context: ShellSpillContext
  /** The raw subprocess spill file to persist and remove. */
  rawPath: string
  /** Which stream the file holds (`stdout` or `stderr`); names the stored artifact. */
  label: string
  /** Sink for the contained handoff failure (storage or removal). */
  warn: (message: string) => void
}

/**
 * Persist one raw subprocess spill file through the session's spill store and
 * delete the raw file, returning the durable model-facing locator. Every
 * failure is contained: a storage failure (or an absent store) returns
 * `undefined` so the caller keeps advertising the raw path, which the
 * subprocess service's disposal and host-exit cleanup still own.
 * @param params - the store, resolved ownership, raw path, stream label, and warning sink.
 * @returns the stored locator, or `undefined` when the output stays on the raw file.
 */
export async function retainSpillOutput(params: RetainSpillOutputParams): Promise<string | undefined> {
  const { store, context, rawPath, label, warn } = params
  if (store === undefined) return undefined
  let content: string
  try {
    // The collector wrote these bytes as UTF-8 text; invalid sequences decode
    // lossily exactly like the in-memory tail the caller already received.
    content = await readFile(rawPath, 'utf8')
  } catch (error: unknown) {
    warn(`shell spill handoff: could not read ${rawPath}: ${String(error)}; keeping the raw file`)
    return undefined
  }
  let locator: string
  try {
    const ref = await store.saveText({
      owner: { sessionId: context.sessionId },
      source: { toolName: context.toolName, callId: context.callId, label },
      suggestedName: `${context.toolName}-${label}.txt`,
      content,
    })
    locator = ref.locator
  } catch (error: unknown) {
    warn(`shell spill handoff: could not persist ${rawPath}: ${String(error)}; keeping the raw file`)
    return undefined
  }
  try {
    await rm(rawPath, { force: false })
  } catch (error: unknown) {
    // The stored copy is authoritative now; a failed removal only leaves a
    // stray the subprocess service's exit cleanup still reclaims.
    warn(`shell spill handoff: could not remove ${rawPath}: ${String(error)}`)
  }
  return locator
}
