import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const [kind, trigger, root] = process.argv.slice(2)
if ((kind !== 'ordinary' && kind !== 'terminal' && kind !== 'spill')
  || (trigger !== 'direct' && trigger !== 'uncaught-exception'
    && trigger !== 'unhandled-rejection' && trigger !== 'dispose')
  || root === undefined) {
  throw new Error('usage: process-exit-host.ts <ordinary|terminal|spill> <direct|uncaught-exception|unhandled-rejection|dispose> <root>')
}

const treeState = join(root, 'tree.json')
const proceed = join(root, 'proceed')
const managedTree = fileURLToPath(new URL('./managed-tree.ts', import.meta.url))

async function waitForFile(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path)
      return
    } catch (_notReady) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

const listenersBefore = process.listenerCount('exit')
const ctx = new Context()
const fiber = await ctx.plugin(LocalSubprocessRuntime)
const listenersAfterLoad = process.listenerCount('exit')
if (kind === 'spill') {
  // One oversized collected stream: the collector spills to the private
  // per-process directory, and the exit phase must remove that directory.
  const handle = ctx.subprocess.spawn({
    argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(500))'],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 10, spill: { maxBytes: 10_000 } },
      stderr: { maxBytes: 1024 },
    },
    graceMs: 30_000,
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0) throw new Error(`spill producer exited ${outcome.exitCode}`)
  const read = handle.collected.stdout?.readFrom(0)
  if (read?.spillPath === undefined) throw new Error('expected a spill file for the oversized stream')
  await writeFile(join(root, 'spill.json'), JSON.stringify({ spillPath: read.spillPath }))
} else if (kind === 'ordinary') {
  ctx.subprocess.spawn({
    argv: [process.execPath, managedTree, treeState],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: trigger === 'dispose' ? 100 : 30_000,
  })
} else {
  await ctx.subprocess.spawnTerminal({
    argv: [process.execPath, managedTree, treeState],
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs: 30_000,
  })
}

await waitForFile(kind === 'spill' ? join(root, 'spill.json') : treeState)
if (kind !== 'spill') {
  const published = JSON.parse(await readFile(treeState, 'utf8')) as { root?: unknown; descendant?: unknown }
  if (!Number.isSafeInteger(published.root) || !Number.isSafeInteger(published.descendant)) {
    throw new Error('managed tree published invalid process ids')
  }
}
await waitForFile(proceed)

if (trigger === 'dispose') {
  await fiber.dispose()
  await writeFile(join(root, 'dispose.json'), JSON.stringify({
    listenersBefore,
    listenersAfterLoad,
    listenersAfterDispose: process.listenerCount('exit'),
  }))
} else if (trigger === 'direct') {
  process.exit(23)
} else if (trigger === 'uncaught-exception') {
  setImmediate(() => { throw new Error('host-exit-uncaught-exception') })
  await new Promise(() => {})
} else {
  void Promise.reject(new Error('host-exit-unhandled-rejection'))
  await new Promise(() => {})
}
