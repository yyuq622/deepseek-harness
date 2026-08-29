# Agent Note: Anchored credential-shaped env scrubbing

Status: implemented

English | [中文](2026-08-29-anchored-env-scrubbing.zh.md)

## Problem

The credential scrub dropped every ambient environment name whose key merely CONTAINED `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` as a substring. Benign names paid the price: `TOKENIZERS_PARALLELISM`, `KEYCLOAK_HOST`, or a hypothetical `MONKEYPATCH` were silently stripped from every child environment, and nothing recorded which keys had been dropped — an over-scrub was undiagnosable from the child's behavior alone. The known gaps were recorded as future work in the provider README.

## Decision

The scrub rule is now shape-based, and it is observable:

- `SENSITIVE_ENV_PATTERN` anchors the credential word to whole underscore-delimited segments — `^(?:.*_)?(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)(?:_.*)?$`, case-insensitive, with `CREDENTIAL` added. `DEEPSEEK_API_KEY`, `GITHUB_TOKEN`, and `MY_SECRET_VALUE` still match; `TOKENIZERS_PARALLELISM` and `KEYCLOAK_HOST` no longer do.
- `SCRUB_ALLOWED_ENV_KEYS` is the recorded allowlist, checked before the pattern and matched case-insensitively. It is the escape hatch for benign names whose benign-ness the segment rule cannot express, and it can never re-admit a `DSH_*` name, which the scrub drops unconditionally.
- `scrubbedParentEnv()` prints the dropped key NAMES — never values — on the `dsh-subprocess:env-scrub` Node debug channel (`NODE_DEBUG=dsh-subprocess:env-scrub`), so an over-scrub is diagnosable from the child's launch environment alone.

The `DSH_*` drop is unconditional and stays ahead of the allowlist: harness identity never leaks implicitly, whatever the allowlist says.

## Alternatives considered

**Keep the substring heuristic and only add the allowlist.** Rejected: the allowlist would grow one entry per benign name in the wild — the substring shape itself is the defect, and every future credential-shaped false positive would need a code change.

**Anchor on word boundaries (`\b`) instead of underscore segments.** Rejected: `\bKEY\b` still matches the `KEY` inside `KEYCLOAK` (a word boundary at the string edge), and environment names have no spaces, so underscore segments are the natural word unit; `\b` would re-introduce the same false positives.

**Make the allowlist a deployment config on the subprocess service.** Rejected for now: the service deliberately has no config (every disposition arrives on the spec), and no deployment has needed a custom exception yet. A recorded constant keeps the mechanism shipped without inventing a knob; promote it to validated config when a second deployment needs a different set.

## Consequences

Child environments keep benign containment-only names without a per-name exception, and every dropped key name is observable on demand. Conservative within a segment: `PASSWORD_FILE` still matches and is still dropped — the rule errs toward dropping anything that names a credential shape. Differently named secrets (`*PASSPHRASE*`) still pass through, unchanged from the documented heuristic cost.

## Testing

`service.spec` pins the shape table: containment-only names survive (`TOKENIZERS_PARALLELISM`, `KEYCLOAK_HOST`), whole-segment shapes are dropped (`GPG_KEY`, `*SECRET_VALUE`), the allowlist admits case-insensitively, and the exported pattern/allowlist pair matches the documented table — alongside the pre-existing case-insensitive `DSH_*` and credential-shaped drops.
