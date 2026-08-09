# PatchLens AI - Ordered implementation flow

This document turns the product roadmap into an execution sequence. It describes what should be built next, why the order matters, and what evidence is required before moving to the following stage.

## Current source-level prototype

The repository currently contains:

- A pnpm and TypeScript monorepo foundation.
- Shared selection and agent protocol types.
- React/Vite development-time source instrumentation.
- A local source-manifest endpoint.
- Hover, click, and rectangle-drag inspection.
- Selection messages from the preview to PatchLens Studio.
- A source-context panel and chat anchored to the selection.
- Desktop, Tablet, and Mobile preview presets with responsive-width rotation.
- Selection rectangle and viewport metadata updates after preview resize.
- A documented competitive position centered on visual grounding, safe transactions, verification, and provider independence.
- A local daemon with provider discovery, cancellation, active-selection sync, origin restrictions, and transaction history APIs.
- A bounded context builder for sanitized DOM, computed styles, accessibility, viewport state, and runtime errors.
- A provider-independent bridge with mock, Codex CLI, and Claude Code CLI adapters.
- Read-only provider proposal mode followed by PatchLens-owned exact replacements.
- Atomic multi-file transactions, explicit scope expansion, compensating rollback, durable JSON history, restart recovery, unified diffs, and conflict-aware undo.
- Diff, History, scope approval, and safe undo surfaces in Studio.
- A read-only MCP server and `patchlens mcp` command for external agents.
- A React/Vite demo application.
- CLI foundations for `patchlens init` and `patchlens doctor`.

Dependency installation and full build verification still need to run in an environment with npm registry access:

```bash
pnpm install
pnpm build
pnpm dev
```

## Stage 1 - Verify the current vertical slice

### Objective

Prove that the existing source implementation behaves correctly before connecting a real coding agent.

### Tasks

1. Install workspace dependencies.
2. Run TypeScript checks for every package.
3. Run production builds for Studio, daemon, packages, and demo.
4. Start all three local services with one command.
5. Hover elements in the demo and confirm the highlight follows the pointer.
6. Click the primary CTA and confirm Studio receives its source component.
7. Drag across several elements and inspect the ranked result.
8. Scroll and resize the preview while a selection is active.
9. Send several messages through the anchored chat.
10. Confirm the mock daemon keeps the same session ID for the conversation.
11. Switch among Desktop, Tablet, and Mobile while a selection is active.
12. Rotate Tablet and Mobile and confirm the iframe width changes to the documented breakpoint.
13. Confirm the same selection ID and mock session survive responsive changes.

### Required evidence

- No TypeScript or build errors.
- No absolute machine paths in the source manifest.
- No PatchLens metadata in a production demo build.
- The Inspector does not change the demo layout.
- Anchored chat remains connected to the selected region.
- Responsive requests contain the named preset, orientation, and measured iframe dimensions.
- The same selection thread survives multiple mock-agent messages.

### Exit condition

The complete mock flow works from selection to contextual reply without manual source-file input.

## Stage 2 - Strengthen source resolution

### Objective

Make visual-to-code mapping reliable enough for real file edits.

### Tasks

1. Extract selection ranking into `packages/selection-engine`.
2. Add fixtures for common React component patterns.
3. Add fragment and multiple-root handling.
4. Add wrapper-component handling.
5. Evaluate React Fiber as a development-only fallback.
6. Add source-map fallback when compiler metadata is missing.
7. Return several candidates for ambiguous selections.
8. Record why each candidate received its confidence score.
9. Add selection telemetry locally for debugging without sending user data externally.

### Required evidence

- Automated tests cover direct DOM elements, wrapper components, fragments, portals, and shared primitives.
- Exact selections consistently resolve to the expected file and line.
- Ambiguous selections return useful alternatives instead of a false exact result.

### Exit condition

The selection contract is stable enough that downstream agent integrations do not need framework-specific guesswork.

## Stage 3 - Build complete selection context

### Objective

Provide agents with enough structured context to understand the selected interface without sending the entire application.

### Tasks

1. [x] Sanitize the selected DOM subtree.
2. [x] Remove passwords, tokens, form values, event handlers, and known secret attributes.
3. [x] Capture a limited set of relevant computed styles.
4. [x] Capture accessibility name, role, and state.
5. [x] Capture the selected rectangle and measured viewport.
6. [x] Capture the active route, named responsive preset, and orientation.
7. Capture selected-region screenshots.
8. [x] Capture current window and unhandled-promise runtime errors.
9. Discover related source and style files.
10. [x] Add payload size limits and truncation rules.
11. [x] Display context size, style count, and error count inside Studio.
12. [x] Make viewport width and height authoritative when preset labels and measured values disagree.

### Required evidence

- Sensitive fields are removed in automated tests.
- The payload stays bounded for large DOM subtrees.
- A developer can see exactly what will be sent to the provider.

### Exit condition

The context payload is safe, inspectable, bounded, and sufficient for a mock agent to identify the intended source scope.

## Stage 4 - Implement patch transactions

### Objective

Create a safe file-editing layer before enabling a real autonomous agent.

### Tasks

1. [x] Capture a baseline for deterministic mock patches.
2. [x] Track the file changed while the mock request is active.
3. [x] Detect developer changes before undo through content hashes.
4. [x] Generate a unified diff for the transaction.
5. [x] Associate the transaction with session and selection IDs.
6. [x] Implement transaction-scoped undo.
7. [x] Prevent lexical and symlink writes outside the approved project root.
8. [x] Detect scope expansion into shared or unrelated files.
9. [x] Store transaction state locally for recovery after a daemon restart.
10. [x] Add failure and partial-change handling with compensating rollback.
11. [x] Generalize the manager to atomic multi-file provider transactions.
12. [x] Add explicit developer approval when a provider expands beyond the selected source scope.

### Proposed contract

```ts
type PatchTransaction = {
  id: string;
  sessionId: string;
  selectionId: string;
  instruction: string;
  files: PatchFileChange[];
  scopeExpansion: string[];
  status: "running" | "applied" | "reverted" | "conflicted" | "failed";
  undoAvailable: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### Required evidence

- Undo restores only agent-owned changes.
- Existing uncommitted developer changes remain untouched.
- The implementation does not use destructive repository resets.
- Interrupted transactions can be diagnosed and recovered.

### Exit condition

A mock editor can safely change files, show a diff, and undo its own work in a dirty repository.

Stage 4 is implemented at source level and has direct Node runtime coverage for multi-file apply, durable restart loading, safe undo, scope approval, and concurrent-edit conflicts. Full workspace typecheck and browser validation remain part of Stage 1.

## Stage 5 - Integrate Codex managed sessions

### Objective

Replace the mock agent with a supported Codex integration while preserving the shared PatchLens protocol.

### Tasks

1. Verify the official Codex surface for creating and continuing sessions.
2. [x] Detect local CLI availability; provider authentication-state diagnostics remain open.
3. [x] Implement the Codex adapter inside `packages/coding-provider`.
4. [x] Scope Codex requests and file authorization to an approved project root.
5. Store the provider session ID in the daemon registry.
6. Stream agent status, assistant messages, tool activity, and changed files.
7. [x] Send structured, bounded selection context and recent conversation history.
8. [x] Connect exact provider replacements to the active patch transaction.
9. [x] Support cancellation, timeout, temporary-output cleanup, and provider failures.
10. Handle authentication setup and unsupported installed CLI versions.

### Context delivered to Codex

- User instruction.
- Selection ID and confidence.
- Component and source candidates.
- Sanitized DOM.
- Selected-region screenshot.
- Relevant computed styles.
- Route and viewport.
- Existing console errors.
- Scope policy.
- Verification requirements.

### Required evidence

- A Studio message reaches the same Codex session on every follow-up.
- Codex receives the selected component instead of the entire repository by default.
- Changed files are captured in a patch transaction.
- Cancellation stops the active request cleanly.

### Exit condition

Codex can edit the intended component from an anchored Studio conversation and return a reviewable transaction.

## Stage 6 - Add live visual verification

### Objective

Close the loop between file edits and visible results.

### Tasks

1. [x] Check whether the active development-preview route remains reachable after a file change.
2. Detect exact HMR completion after a file change.
3. Wait for the selected component to render again.
4. Capture new console and runtime errors.
5. Capture the selected region after the change.
6. Compare before and after images.
7. Display the visual comparison next to the source diff.
8. Run configured lint, typecheck, or test commands.
9. Report missing components or broken routes.
10. Keep the same selection thread active after verification.
11. Verify the active responsive viewport before running broader regression captures.
12. Add optional Desktop/Tablet/Mobile comparison captures.
13. Add custom width and height controls with saved project-level device presets.
14. Evaluate zoom, touch/hover capability, reduced-motion, safe-area, and device-scale emulation.

### Required evidence

- PatchLens can distinguish successful HMR from a broken preview.
- New runtime errors are attached to the transaction.
- The developer can inspect both code and visual changes.
- The verification report identifies which responsive viewport was tested.

### Exit condition

Every completed agent request produces a diff, a visible result, and a verification report.

## Stage 7 - Implement Codex MCP attached mode

### Objective

Allow Codex running outside PatchLens Studio to retrieve and use the current visual selection.

### Tasks

1. [x] Implement `packages/mcp-server`.
2. Authenticate communication with the local daemon.
3. [x] Expose the active selection and bounded context as a tool and resource.
4. [x] Expose transaction history as a read-only tool and resource; verification tools remain open.
5. [x] Add the `patchlens mcp` stdio command.
6. Implement `patchlens connect codex`.
7. Add a Codex skill or plugin describing the PatchLens workflow.
8. Implement `patchlens disconnect codex`.
9. Extend `patchlens doctor` with MCP transport diagnostics.
10. Document the difference between managed and attached sessions.

### Initial MCP tools

```text
patchlens_get_active_selection
patchlens_list_transactions
patchlens_get_source_context
patchlens_get_console_errors
patchlens://selection/current
patchlens://transactions
```

### Required evidence

- An external Codex task can retrieve the exact active selection.
- Tool responses never expose files outside the approved project root.
- MCP configuration can be installed and removed without overwriting unrelated user settings.

### Exit condition

A developer can select a component in PatchLens and ask an external Codex task to edit that selection.

## Stage 8 - Add Claude and framework adapters

### Objective

Prove that PatchLens is provider-independent and framework-extensible.

### Tasks

1. [x] Implement the Claude Code CLI adapter in `packages/coding-provider`.
2. Add Claude attached-session configuration.
3. Add Next.js source instrumentation.
4. Handle Server and Client Component boundaries.
5. Add framework capabilities to `patchlens doctor`.
6. Evaluate Vue and Svelte compiler adapters.
7. Run the same selection-contract tests across all supported frameworks.

### Required evidence

- Codex and Claude use the same Studio request contract.
- React/Vite and Next.js produce compatible selection results.
- Provider-specific behavior remains isolated inside adapters.

### Exit condition

At least two agents and two framework environments pass the same core workflow.

## Stage 9 - External pages and distribution

### Objective

Support workflows beyond injected localhost previews and prepare public package distribution.

### Tasks

1. Design a browser-extension or controlled reverse-proxy mode.
2. Add explicit origin and page permissions.
3. Prevent context capture from unrelated tabs.
4. Publish `@patchlens-ai/dev`.
5. Add protocol versioning and migrations.
6. Add release automation and changelogs.
7. Define licensing and contribution policy.
8. Add installation and troubleshooting documentation.
9. Add opt-in, privacy-preserving diagnostics.

### Exit condition

A developer can install a released PatchLens package into a supported repository and follow a documented, recoverable workflow.

## Recommended execution order

```text
Verify the current prototype
  → Strengthen source resolution
  → Complete selection context
  → Build patch transactions
  → Integrate Codex managed sessions
  → Add live visual verification
  → Add Codex MCP attached mode
  → Add Claude and Next.js
  → Add external-page support and publish packages
```

Patch transactions must come before autonomous file editing. Codex managed sessions should be stable before Claude is added. External-page support should wait until local preview permissions and context sanitization are proven safe.
