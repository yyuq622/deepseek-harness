/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response first passes Connection's browser authentication, then the
 * webserver's index render (structured injection rows, then raw taps).
 * Non-index assets stay public. A link planted inside the dist cannot serve a
 * file outside it: file targets are resolved to their final location with
 * `realpath` and re-verified against the real root before any bytes move.
 * Content-hash-named assets serve `immutable`, the index serves `no-cache`
 * with an ETag over its rendered body, and files at or above 1 MiB stream
 * from disk instead of buffering whole. The
 * dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { createReadStream, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Content-hash-shaped asset names (a Vite-style `-hash` segment before the
 * extension) are served `immutable`: in a content-hashed dist the same name
 * is the same content, so browsers never revalidate them.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9.]+$/

/** Files at or above this size stream from disk instead of buffering whole. */
const STREAM_FILE_MIN_BYTES = 1_048_576

/** Cache lifetime for content-hash-named assets: one year, the standard immutable bound. */
const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Whether `target` is `root` itself or stays beneath it. Path case folds on
 * Windows, where realpath reports on-disk casing that can differ from the
 * casing the dist root was configured with.
 */
function underRoot(target: string, root: string): boolean {
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
  const targetPath = fold(target)
  const rootPath = fold(root)
  return targetPath === rootPath || targetPath.startsWith(rootPath + sep)
}

/** Weak ETag over the rendered index body: injection rows and taps participate. */
function weakEtag(body: string): string {
  return `W/"${createHash('sha256').update(body).digest('base64url')}"`
}

/** RFC 7232 If-None-Match matching: `*`, exact, or weak comparison per candidate. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/^W\//, '')
  const target = normalize(etag)
  return ifNoneMatch.split(',').some((candidate) => {
    const value = normalize(candidate)
    return value === '*' || value === target
  })
}

/** Stream one file to the response with contained failure: a mid-stream error
 * destroys the response (the client sees a truncated body) instead of
 * throwing after the headers are already written. Resolves when the stream
 * finishes or the response closes. */
function streamFile(res: ServerResponse, path: string): Promise<void> {
  return new Promise((resolve) => {
    const stream = createReadStream(path)
    const done = (): void => {
      stream.destroy()
      resolve()
    }
    stream.on('error', () => { res.destroy() })
    res.on('close', done)
    stream.pipe(res)
  })
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - the dist root's realpath (resolved once by the caller at activation).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 * @param ifNoneMatch - the request's If-None-Match header, for index revalidation.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
  ifNoneMatch?: string | undefined,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection (lexical): the target must be distRoot itself (`/`) or
  // stay under it. `sep`, not '/': resolve() emits backslash paths on Windows,
  // where a '/' suffix would reject every legitimate subpath as traversal.
  if (!underRoot(target, distRoot)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  let cacheControl: string | undefined
  let etag: string | undefined
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      body = await renderIndex()
      type = HTML_MIME
      // The rendered body carries the injection rows and taps, so the ETag is
      // computed per render and no-cache forces revalidation on every visit.
      cacheControl = 'no-cache'
      etag = weakEtag(body)
      if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, etag)) {
        res.writeHead(304, { etag, 'cache-control': cacheControl })
        res.end()
        return
      }
    } else {
      // readFile follows symlinks and junctions, so resolve the target to its
      // final location and re-verify containment against the real root before
      // any bytes are read — a link planted inside the dist cannot serve a
      // file outside it. Windows realpath reports on-disk casing, which the
      // containment compare folds.
      const resolved = await realpath(target)
      if (!underRoot(resolved, distRoot)) {
        res.writeHead(403)
        res.end()
        return
      }
      const stats = await stat(resolved)
      type = MIME[extname(resolved)] ?? 'application/octet-stream'
      if (HASHED_ASSET.test(resolved)) cacheControl = HASHED_ASSET_CACHE_CONTROL
      if (stats.size >= STREAM_FILE_MIN_BYTES && res.req.method !== 'HEAD') {
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(stats.size),
          ...cacheControl !== undefined ? { 'cache-control': cacheControl } : {},
        })
        await streamFile(res, resolved)
        return
      }
      body = await readFile(resolved)
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': type,
    ...cacheControl !== undefined ? { 'cache-control': cacheControl } : {},
    ...etag !== undefined ? { etag } : {},
  })
  res.end(body)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  // One activation-time resolution: the served root is the dist directory's
  // real location, so a symlinked install path cannot break the containment
  // compares and the SPA index anchors to the same real root. A missing dist
  // fails loud at load instead of at first request.
  const distRoot = realpathSync(dirname(distIndex))
  const distIndexReal = join(distRoot, basename(distIndex))
  // The dist is built with a relative base so the same files mount under any
  // static directory; served pages also answer deep SPA-fallback paths, where
  // relative asset URLs would resolve under the request directory, so the
  // served form anchors them at the site root ahead of every URL-bearing tag.
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="/">`)
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndexReal,
      () => ctx.connection.authorizeIndex(req, res),
      renderIndex,
      Array.isArray(req.headers['if-none-match']) ? req.headers['if-none-match'][0] : req.headers['if-none-match'],
    )
  }), 'frontend-static: fallback seat')
}
