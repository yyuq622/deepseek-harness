# Agent Note: Frontend-static realpath containment

Status: implemented

English | [中文](2026-08-29-frontend-static-realpath-containment.zh.md)

## Problem

The static seat's traversal fence was purely lexical: the requested pathname was joined to the dist root and prefix-checked, but `readFile` follows symlinks and junctions. A single link planted inside the dist directory — pointing anywhere on the host — served that outside file to any browser that could reach the server, with no authentication (non-index assets are public).

## Decision

File targets are resolved to their final location with `realpath` and re-verified against the dist root's real location before any bytes are read. The real root is resolved once at activation (`realpathSync` of `dirname(distIndex)`), so the compare basis survives a symlinked install path and a missing dist fails loud at load instead of at first request; the SPA index anchors to the same real root. The containment compare folds path case on Windows, where realpath reports on-disk casing that can differ from the configured casing, and realpath resolves junctions the same way it resolves symlinks, so both link shapes are fenced. The lexical prefix check stays as the first fence; the realpath re-verification closes the link-shaped gap behind it.

## Alternatives considered

**Serve the lexically verified configured path and skip realpath.** Rejected outright — that is the defect: the check verifies the pathname's shape, not what the filesystem hands back.

**Open with `O_NOFOLLOW` and serve by fd.** Rejected: Node has no nofollow open on Windows, and the served tree legitimately contains no links, so a post-open link swap window was accepted rather than carrying a platform-split read path. An attacker who can swap links inside the dist can already replace every file the dist serves.

**Reserve and verify at build time (a dist manifest).** Rejected for now: it shifts the fence to the build pipeline and breaks live-rebuild workflows where files appear between requests. Revisit if the dist ever becomes untrusted by construction.

## Consequences

A link planted inside the dist answers 403 instead of serving an outside file, and the fence holds on Windows (junctions, case folding) and on macOS install paths where `/tmp` is itself a symlink. Cost: one realpath per non-index request and one `realpathSync` at activation — activation now fails loud when the configured dist is missing, which is a misconfiguration and not a runtime condition. The residual window is a link swapped between the realpath check and the read; closing it needs a nofollow read the platform split does not offer, and an attacker with that write access already controls the dist's contents.

## Testing

The real-Loader composition suite adds a planted-link scenario: a junction on Windows (no privilege required) or a symlink elsewhere, pointing from inside the dist at a secret outside it, must answer 403 while a legitimate asset keeps serving.
