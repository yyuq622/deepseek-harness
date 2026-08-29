# Agent Note: Static cache headers and streamed large files

Status: implemented

English | [中文](2026-08-29-static-cache-headers.zh.md)

## Problem

The static seat served every response bare: no cache directives at all. Browsers re-fetched identical hashed bundles on every visit, the index could not be revalidated (a full re-download per visit), and files at or above a megabyte were buffered whole in memory per concurrent request.

## Decision

Caching follows the dist's naming, and large files stop being buffered:

- A content-hash-shaped asset name — a Vite-style `-hash` segment of exactly 8 base64-ish characters before the extension — serves `Cache-Control: public, max-age=31536000, immutable`. In a content-hashed dist the same name is the same content, so browsers never revalidate. Other files carry no directive (heuristic cost: an unhashed file whose name happens to look hashed would be served stale on change — no such name exists in a Vite dist).
- The index serves `Cache-Control: no-cache` with a weak ETag computed over the RENDERED body — injection rows and taps participate, so a changed page yields a changed ETag. A matching If-None-Match answers 304 with the ETag and cache directive attached.
- Files at or above 1 MiB stream through `createReadStream` with an explicit content length, so a bundle buffers no more; a mid-stream failure destroys the response instead of throwing past the written headers, and a client disconnect destroys the stream (no fd leak). HEAD requests skip the stream and read nothing.

The realpath containment fence runs before every file read, streamed or buffered; `stat` on the resolved path sizes the stream.

## Alternatives considered

**Content-hash every response and skip the name heuristic.** Rejected: the index body is rendered per request (injection rows and taps), and the heuristic maps names to cache policy without hashing every file — a plain content hash of unhashed names would serve stale content after a rebuild.

**Cache the rendered index server-side and skip the ETag.** Rejected: injection rows are gathered fresh per render by design (boot payloads differ per deployment); the ETag gives revalidation without inventing an invalidation protocol.

**Config for the TTL/threshold.** Rejected for now: one year immutable and a 1 MiB stream threshold are standard bounds with no deployment variance observed; promote to validated config when one appears.

## Consequences

Browsers stop re-fetching identical hashed bundles and revalidate the index instead; bundles at or above the threshold stream. The heuristic's false-positive cost is bounded by the dist being a build artifact (same name, same content). The index ETag is computed per render — one SHA-256 over a small body per index request.

## Testing

The real-Loader composition suite asserts the response headers: a hash-shaped asset serves `immutable`, an unhashed asset carries no directive, the index serves `no-cache` with an ETag that revalidates to 304 and changes when a tap changes the body, and a 1.5 MiB file serves with its content length and complete body.
