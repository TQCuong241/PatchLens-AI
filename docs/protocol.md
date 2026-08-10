# PatchLens Protocol

Protocol public nằm trong `@patchlens-ai/agent-protocol`.

## Source of truth

- Constants và payload limits: `packages/agent-protocol/src/constants.ts`.
- Selection và source context: `packages/agent-protocol/src/selection.ts`.
- Inspector và Studio messages: `packages/agent-protocol/src/messages.ts`.
- Agent request, session và events: `packages/agent-protocol/src/agent.ts`.
- Runtime validation: `packages/agent-protocol/src/validation.ts`.
- Versioning decision: `docs/adr/0001-protocol-v1.md`.

## Boundary rules

1. Kiểm tra origin tại browser boundary.
2. Kiểm tra `channelId` và `projectId` theo active Studio session.
3. Chạy `parseInspectorMessage`, `parseStudioMessage` hoặc `parseAgentRequest` trước khi dùng payload.
4. Không nhận unknown type hoặc protocol version.
5. Không đưa raw HTML, absolute project path hoặc secret vào payload.

## Correlation

- `messageId` nhận diện một browser message.
- `selectionId` nhận diện visual selection.
- `requestId` nhận diện một yêu cầu agent.
- `sessionId` nhận diện provider session.
- `transactionId` nhận diện thay đổi file và undo scope.

## Evolution

Protocol v1 chưa được publish. Breaking change trước public release vẫn phải cập nhật ADR, runtime validator và contract tests trong cùng patch.
