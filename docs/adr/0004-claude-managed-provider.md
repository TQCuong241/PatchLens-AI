# ADR 0004: Claude managed provider

- Status: Accepted
- Date: 2026-08-09

## Context

PatchLens needs a managed Claude session that can read and edit the selected local repository, stream progress, resume by provider session ID, and obey the same patch transaction boundary as Codex.

Anthropic provides three relevant surfaces: the Client SDK, Claude Managed Agents, and the Claude Agent SDK. The Client SDK requires PatchLens to build and secure its own tool loop. Managed Agents run in Anthropic infrastructure and require repository upload or mounting. The Agent SDK runs the Claude coding loop in the daemon process and supports local `cwd`, streamed messages, cancellation, permissions, and session resume.

## Decision

Use `@anthropic-ai/claude-agent-sdk` through its TypeScript `query()` API.

PatchLens configures each turn with:

- Canonical project root as `cwd`.
- Explicit tool surface: `Read`, `Glob`, `Grep`, `Edit`, and `Write`.
- No Bash, web, MCP, subagents, notebooks, interactive questions, or worktrees.
- Programmatic path authorization for every tool request.
- No user, project, or local Claude settings through `settingSources: []`.
- Strict MCP configuration, auto-memory disabled, and PatchLens-owned system prompt.
- AbortController cancellation and bounded timeout.
- Resume through captured Agent SDK `session_id`.
- PatchLens transaction diff and undo remain source of truth; Claude checkpointing supplies secondary file evidence only.

## Consequences

- Users authenticate with API-supported Claude Agent SDK credentials. PatchLens does not embed or proxy claude.ai login.
- Agent SDK session history persists on the same machine. Cross-host resume needs a future `SessionStore` integration.
- Claude cannot run project commands. Verification stays in PatchLens command allowlist after edits.
- Managed enterprise policy may still apply because the Agent SDK always honors managed settings.
- Real provider tests require the native Agent SDK package and credentials; unit tests inject a fake `query()` stream.

## References

- Claude Agent SDK overview and TypeScript reference.
- Claude Agent SDK session, permission, and secure deployment documentation.
