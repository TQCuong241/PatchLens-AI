# PatchLens AI - Competitive landscape and product differentiation

This document defines how PatchLens AI should position itself among visual development tools, source inspectors, and AI coding agents. It is intentionally based on durable product categories and public project descriptions rather than time-sensitive star counts or market rankings.

## 1. Short answer

The core interaction is not unique by itself. Several public projects already let a developer point at an interface element, recover some implementation context, or ask an AI tool to change a web application.

PatchLens should therefore not compete on the sentence:

> Select an element and ask AI to edit it.

PatchLens should compete on the complete trusted workflow:

> Select a visual region, preserve that intent across responsive states, ground it to source code, route it to any supported coding agent, capture every edit as a safe transaction, verify the visible result, and undo only agent-owned changes.

## 2. Public reference projects

| Project                                                                  | Primary focus                                                                       | Relevant lesson for PatchLens                                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [stagewise](https://github.com/stagewise-io/stagewise)                   | Browser-based visual context and AI-assisted frontend editing.                      | The select-and-prompt workflow has real demand. PatchLens needs deeper safety, portability, and verification rather than a minor variation of the same toolbar.   |
| [React Grab](https://github.com/aidenybai/react-grab)                    | Selecting React elements and passing useful context to coding agents.               | Fast visual capture and low-friction installation are important. PatchLens should preserve this speed while adding durable sessions and patch review.             |
| [Onlook](https://github.com/onlook-dev/onlook)                           | Visual editing for React applications with AI-assisted workflows.                   | A complete visual editor is powerful, but PatchLens should remain a context and patch layer for an existing repository instead of becoming a proprietary builder. |
| [click-to-component](https://github.com/ericclemmons/click-to-component) | Opening the source component that owns a selected React element.                    | DOM-to-source mapping is a proven primitive and should remain independently testable.                                                                             |
| [react-dev-inspector](https://github.com/zthxxx/react-dev-inspector)     | Inspecting a rendered element and locating its source file.                         | Source instrumentation can be useful without an AI layer; PatchLens should expose mapping confidence instead of hiding uncertainty.                               |
| [BrowserTools MCP](https://github.com/AgentDeskAI/browser-tools-mcp)     | Giving coding agents browser, console, network, and screenshot context through MCP. | MCP is a strong attached-session bridge, but browser telemetry alone does not create component-level source grounding or safe repository transactions.            |

These projects should be reviewed for ideas, interoperability, and licensing boundaries. PatchLens must not copy implementation details without confirming the applicable license.

## 3. Differentiation pillars

### 3.1. Region-level visual grounding

PatchLens supports both click selection and rectangle selection. A developer may mean one element, a component composed of several nodes, or a visual region that has no one-to-one DOM boundary.

The result contains:

- A stable selection ID.
- The selected rectangle and ranked elements.
- Component, file, line, and column candidates.
- Exact, likely, or visual-only confidence.
- Sanitized DOM and bounded visual context.

### 3.2. A durable conversation attached to intent

The selection is not discarded after the first prompt. Follow-up messages continue to carry the same visual intent until the developer explicitly reselects or attaches another region.

Chat should remain synchronized when:

- The preview scrolls.
- The iframe resizes.
- The responsive preset changes.
- HMR replaces the selected DOM node with another node carrying the same source identifier.

### 3.3. Responsive-aware requests

PatchLens treats viewport state as agent context.

- Desktop, Tablet, Mobile, and later Custom are named presets.
- Width, height, orientation, and device scale factor are included in the request.
- The measured iframe dimensions remain authoritative.
- Verification starts at the viewport where the request was made.
- Optional regression captures can compare other breakpoints later.

### 3.4. Provider-independent agent sessions

Inspector and Studio use shared contracts. Provider-specific behavior belongs in adapters.

The intended connection modes are:

- Managed Codex sessions.
- Managed Claude sessions.
- MCP attached mode for explicitly configured external agents.
- Additional providers through the same `CodingProvider` contract.

PatchLens should not require the developer to abandon the coding agent they already use.

### 3.5. Safe patch transactions

Every autonomous edit belongs to a transaction with:

- A project-root authorization check.
- File snapshots captured before editing.
- Changed-file tracking.
- A reviewable unified diff.
- Scope-expansion reporting.
- Concurrent-change detection.
- Transaction-scoped undo.

Undo must never reset the complete repository or overwrite unrelated developer work.

### 3.6. Visual and runtime verification

An agent response is not complete merely because files changed.

PatchLens should:

- Wait for HMR or reload completion.
- Confirm the selected component still renders.
- Capture new console and runtime errors.
- Compare the selected region before and after the patch.
- Run configured typecheck, lint, or test commands.
- Attach the result to the same transaction and conversation.

### 3.7. Repository-native installation

PatchLens is installed into an existing Node.js web repository. The source of truth remains the developer's files, framework, design system, dev server, and Git workflow.

PatchLens is not intended to become:

- A hosted website builder.
- A proprietary source format.
- A replacement for the developer's editor.
- A separate repository that must be exported later.

## 4. Strategic comparison

| Capability                             | Visual prompt tools     | Source inspectors | Browser MCP tools            | PatchLens target                   |
| -------------------------------------- | ----------------------- | ----------------- | ---------------------------- | ---------------------------------- |
| Click a visible element                | Common                  | Common            | Sometimes                    | Yes                                |
| Drag across a visual region            | Varies                  | Rare              | Not the focus                | Yes                                |
| Resolve component and source location  | Varies                  | Core feature      | Usually indirect             | Ranked and confidence-aware        |
| Multi-turn chat bound to the selection | Varies                  | No                | Agent-dependent              | Core contract                      |
| Preserve responsive viewport context   | Varies                  | No                | Raw dimensions at most       | Named and measured context         |
| Work with multiple coding agents       | Often provider-specific | Not applicable    | Strong through MCP           | Managed adapters plus MCP          |
| Capture agent-owned file transactions  | Rare                    | No                | Agent-dependent              | Required before autonomous editing |
| Safe undo in a dirty worktree          | Rare                    | No                | No                           | Core safety property               |
| Verify HMR, runtime, and visual output | Partial                 | No                | Provides raw browser signals | Transaction-level verification     |

## 5. Product questions and answers

### Is PatchLens still worth building if similar tools exist?

Yes, if the project focuses on the complete safe workflow. Existing projects validate the user need. They also raise the quality bar: visual selection alone is not enough differentiation.

### Should PatchLens become a visual website builder?

No. Its strongest position is a local visual-grounding and safe-patch layer for repositories and agents that developers already use.

### Should PatchLens create its own coding model?

No. Provider independence is more valuable. PatchLens should improve context, permissions, transactions, and verification around existing coding agents.

### What is the first defensible technical milestone?

A selected React component can be edited by a deterministic mock provider, the resulting file change is captured as a durable multi-file transaction, the exact diff is reviewable, the preview route is checked, and undo restores only that transaction without removing pre-existing uncommitted work.

### What should be measured during development?

- Source-resolution accuracy.
- Time from selection to useful agent context.
- Percentage of edits confined to the intended scope.
- Transaction conflict rate.
- Undo reliability in dirty repositories.
- Visual verification success at the requested breakpoint.
- Provider adapter consistency.

## 6. Positioning statement

Recommended public positioning:

> PatchLens AI is the visual grounding and safe patch layer for any coding agent.

Expanded version:

> Select the interface you mean, keep that visual intent attached to the conversation, and let Codex, Claude, or another coding agent produce a reviewable, verifiable, and reversible patch in your existing repository.

## 7. Product guardrail

When evaluating a new feature, ask:

1. Does it improve visual-to-code grounding?
2. Does it preserve the developer's intent across conversation and responsive state?
3. Does it make autonomous edits safer or easier to review?
4. Does it work across providers or strengthen a clean adapter boundary?
5. Does it keep the existing repository as the source of truth?

If the answer is no to all five questions, the feature is probably outside PatchLens's core product.
