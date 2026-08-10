# SQLite history evaluation

## Decision

Do not add SQLite now.

Current MVP state is intentionally short-lived:

- Managed provider session IDs live in Studio memory.
- MCP bridge state lives in `.patchlens/session.json` with stale-process checks.
- Patch transactions live in daemon memory and protect current user work.
- Screenshot evidence is bounded local project data.

SQLite would add migrations, retention, corruption recovery, path relocation, secret classification, and deletion semantics before users need durable history.

## Adoption triggers

Add persistence only when at least one measured requirement exists:

- Resume managed sessions after daemon restart.
- Browse transactions across multiple days or projects.
- Audit provider requests and verification evidence.
- Recover selective undo after process failure.

## Proposed schema

- `projects`: canonical root fingerprint and display metadata.
- `sessions`: PatchLens ID, provider ID, provider session ID, status, timestamps.
- `selections`: bounded protocol snapshot without raw screenshot bytes.
- `requests`: instruction digest, scope policy, verification request, terminal state.
- `transactions`: planned, expanded, changed files, diff, conflicts, timestamps.
- `captures`: relative path, MIME, dimensions, byte size, perceptual hash, retention state.

## Security and lifecycle

- Database stays under user data directory, not repository.
- Provider credentials and daemon tokens are never stored.
- Absolute paths are encrypted or replaced by project aliases in export and logs.
- Capture files use short retention and explicit delete-all command.
- Schema migrations are transactional and backed up before upgrade.
- SQLite write access remains daemon-only; Studio uses authenticated API.

## Revisit gate

Revisit after telemetry or user research proves restart resume or durable audit value. Until then, keep state ephemeral and make failure explicit.
