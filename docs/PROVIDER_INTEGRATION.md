# PatchLens AI - Provider and MCP integration

This document describes how PatchLens connects a visual selection to Codex, Claude, or another coding agent without giving the provider uncontrolled write access.

## Core rule

The provider is a read-only patch planner. PatchLens is the only layer allowed to write repository files.

```text
Studio selection
  -> bounded selection context
  -> read-only provider request
  -> exact replacement proposal
  -> path, scope, and baseline validation
  -> atomic PatchLens transaction
  -> diff, history, verification, and safe undo
```

This separation is intentional. If Codex or Claude edits files directly, PatchLens cannot reliably distinguish agent-owned changes from pre-existing developer work, enforce scope expansion, or guarantee conflict-aware undo.

The current prototype receives its project root from the launcher or daemon configuration and rejects lexical and symlink escapes from that boundary. A dedicated first-run screen for reviewing and explicitly approving that root is a release requirement and is not implemented yet.

## Managed provider mode

Studio sends an `AgentRequest` to the local daemon. The request contains:

- The developer instruction.
- The stable selection ID.
- The selected component and source mapping when available.
- The responsive viewport preset, orientation, and measured dimensions.
- Sanitized HTML and a limited computed-style set.
- Accessibility name, role, and state.
- Recent runtime errors.
- Recent conversation messages.
- The selected scope policy and any explicitly approved related files.

The provider must return JSON with exact replacements:

```json
{
  "reply": "Short explanation",
  "providerSessionId": "optional-provider-session-id",
  "edits": [
    {
      "file": "src/components/Hero.tsx",
      "expectedText": "Start planning",
      "replacementText": "Launch workspace"
    }
  ]
}
```

PatchLens rejects a replacement when:

- The path is absolute or resolves outside the configured project root.
- A symlink resolves outside the project root.
- The file extension is not approved source or style text.
- The source file is binary, invalid UTF-8, or too large.
- `expectedText` is missing or occurs more than once.
- The file changed after the provider inspected it.
- The proposal expands beyond the selected source without the required approval.
- The complete transaction exceeds configured file or transaction limits.

## Codex CLI adapter

The daemon detects `codex` with a local version check. When selected, the adapter starts Codex without a shell, scopes it to the configured project root, requests a read-only sandbox, passes the structured PatchLens prompt through standard input, and reads the final JSON response from a temporary file.

Default executable:

```text
codex
```

Override it when Codex is installed at a custom path:

```bash
PATCHLENS_CODEX_COMMAND=/custom/path/to/codex
```

For compatibility testing, the argument template can be overridden with a JSON array. `{projectRoot}` and `{outputFile}` are replaced without invoking a shell:

```bash
PATCHLENS_CODEX_ARGS='["exec","--sandbox","read-only","-C","{projectRoot}","-o","{outputFile}","-"]'
```

The adapter source is implemented, but its exact command-line compatibility still needs to be verified against supported installed Codex versions and current official OpenAI documentation before release. PatchLens therefore reports provider startup and response-shape failures without falling back to unsafe direct writes.

## Claude Code CLI adapter

The daemon detects `claude` with a local version check. The adapter requests non-interactive JSON output in plan mode, passes the same provider-independent prompt, and parses the returned PatchLens replacement proposal.

Default executable:

```text
claude
```

Override it when needed:

```bash
PATCHLENS_CLAUDE_COMMAND=/custom/path/to/claude
```

The Claude argument list can likewise be overridden with `PATCHLENS_CLAUDE_ARGS` as a JSON string array.

Installed Claude CLI versions may expose different flags or authentication behavior. Those combinations must be covered by compatibility tests before public distribution.

## Scope policies

### `prefer-selection`

This is the default. Changes in the selected source may proceed. Related files are reported to Studio and require explicit approval before the same request is retried.

### `strict`

Every changed file must match the selected source file. Any expansion is rejected.

### `allow-related`

The provider may propose related files. Every file is still path-authorized, diffed, persisted, and included in one transaction.

## Transaction behavior

Before writing, PatchLens reads and hashes every affected file. All proposals are prepared before the first write.

If a write or verification fails:

1. PatchLens stops the transaction.
2. It checks that each already-written file still matches the agent result.
3. It restores the original baselines in reverse order.
4. It marks the transaction failed when rollback completes.
5. It marks the transaction conflicted when newer external edits prevent safe rollback.

Transaction records are stored in `.patchlens/transactions.json`. The file is excluded from Git by default because it contains local before/after source snapshots used for recovery and undo.

After a daemon restart, interrupted transactions are reconciled:

- All files match the proposed result: recover as applied and undoable.
- All files match the original baseline: recover as failed without changes.
- Files contain a clean before/after mixture: roll back the partial transaction.
- Any file contains unknown newer content: mark conflicted and do not overwrite it.

## Attached mode through MCP

An external agent does not need PatchLens to own its chat. Run the stdio bridge:

```bash
patchlens mcp
```

The MCP server connects only to an HTTP daemon on the loopback interface and exposes read-only capabilities:

| Capability | Purpose |
| --- | --- |
| `patchlens_get_active_selection` | Return the current Studio selection and bounded context. |
| `patchlens_list_transactions` | Return local transaction metadata and diffs. |
| `patchlens_get_source_context` | Return source candidates without unrelated browser payload. |
| `patchlens_get_console_errors` | Return captured runtime errors for the active selection. |
| `patchlens://selection/current` | Read the current selection as an MCP resource. |
| `patchlens://transactions` | Read transaction history as an MCP resource. |

The MCP server intentionally does not expose write, apply, undo, shell, or Git tools. The external coding agent can use the selection as precise context while its own permission and editing workflow remains visible to the developer.

Automatic installation into Codex or Claude configuration is not implemented yet. `patchlens connect <provider>` will be added only after configuration formats, merge behavior, recovery, and uninstall behavior are verified for each provider.

The intended configuration shape is conceptually similar to the following, but the exact file location and key name must follow the provider's current official documentation:

```json
{
  "mcpServers": {
    "patchlens": {
      "command": "patchlens",
      "args": ["mcp"]
    }
  }
}
```

## Local security boundaries

- The daemon binds to `127.0.0.1` by default.
- Browser calls are accepted only from configured Studio origins.
- Provider processes start without `shell: true`.
- Provider output, duration, prompt size, file size, and transaction size are bounded.
- PatchLens daemon credentials and local connection hints are removed from the provider process environment.
- Captured page content is labeled untrusted so DOM prompt injection cannot override the developer instruction.
- Sensitive form values, inline event handlers, secret-like data attributes, scripts, iframes, and embedded objects are removed from captured HTML.
- Absolute local paths are not returned in transaction errors.
- PatchLens never uses `git reset --hard` for undo.

The current prototype already authenticates Studio with a short-lived browser session cookie and MCP/CLI clients with a daemon bearer token. Origin checks reduce browser exposure, while the token boundary protects the daemon endpoints themselves. Token rotation, provider-specific credential diagnostics, and configuration installers still need release hardening.

## Questions and answers

### Why return exact replacements instead of a unified diff?

Exact replacements are easier to validate deterministically. PatchLens can require one occurrence, verify the source baseline, build its own unified diff, and avoid accepting ambiguous patch offsets.

### Can a provider change multiple files?

Yes. All files are prepared before writing and belong to one transaction. Related files require the selected scope policy or explicit approval.

### What happens if the developer edits a file while the provider is working?

The final baseline check fails and no transaction is applied. If the developer edits after the patch, safe undo is blocked rather than overwriting the newer content.

### Does conversation continuation require a native provider session?

No. PatchLens includes recent conversation messages in every managed request. Native provider-session continuation can improve efficiency and tool continuity, but it is an adapter optimization rather than a requirement for preserving visual intent.

### Can PatchLens attach to any existing chat automatically?

No. External chats must explicitly configure the PatchLens MCP bridge. A local web page should not take control of an unrelated coding-agent conversation.

### Is provider availability the same as authentication readiness?

No. The current probe confirms that a CLI can start and report a version. Authentication and account capability diagnostics are provider-specific follow-up work.

### What remains before calling the integration production-ready?

- Verify Codex CLI arguments against supported official versions.
- Verify Claude Code CLI arguments against supported versions.
- Install dependencies and run strict typecheck/build from a clean checkout.
- Add browser tests for selection, approval, patch, HMR, history, and undo.
- Add token rotation, provider-specific credential diagnostics, and configuration installers.
- Add native provider streaming and session resume where officially supported.
- Add live visual and runtime verification after every applied transaction.
