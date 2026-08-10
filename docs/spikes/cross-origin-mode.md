# Cross-origin preview mode

## Decision

Use an opt-in browser extension for arbitrary cross-origin preview. Do not ship a general reverse proxy.

Reverse proxies must rewrite cookies, CSP, service workers, WebSockets, redirects, origin checks, authentication callbacks, and absolute URLs. They can silently change application behavior and create a credential-handling boundary larger than PatchLens needs.

## Extension architecture

1. User opens Studio and chooses one browser tab.
2. Extension receives `activeTab` permission from that explicit gesture.
3. Content script loads Inspector in selected tab and approved child frames.
4. Extension service worker bridges structured Inspector messages to Studio through a one-time channel ID.
5. Studio keeps daemon token private. Extension never receives repository paths, provider credentials, or patch content.
6. Daemon continues to accept only loopback requests with bearer token and project binding.

## Permission model

- No default `<all_urls>` permission.
- Host permission requested per origin and revoked when disconnected.
- Frame injection restricted to selected tab and frame IDs.
- Channel IDs rotate on reconnect and expire with PatchLens session.
- Messages use protocol validation, payload budgets, and explicit project ID.
- Content script captures only sanitized DOM, computed style allowlist, design tokens, console warning/error, and bounded screenshot evidence.

## Threat model

- Page scripts may forge DOM or console content. Captured data stays untrusted provider input.
- Page scripts must not learn daemon or Studio tokens.
- Extension must reject messages from other tabs, frames, projects, and expired channels.
- Browser sync storage must not hold source, screenshots, tokens, or provider session IDs.
- Incognito support remains off unless user explicitly enables it.

## Controlled reverse proxy exception

A future local-only proxy may support loopback HTTP targets that have no authentication, service worker, or WebSocket dependency. It must be disabled by default, bind loopback, use a random path token, strip cookies, and display a behavior-change warning.

## Delivery slices

- Extension manifest and tab-scoped connection prototype.
- Multi-frame coordinate normalization.
- Permission audit in `patchlens doctor`.
- Automated negative tests for wrong tab, origin, frame, channel, and stale session.
- Store review and signed release only after security review.
