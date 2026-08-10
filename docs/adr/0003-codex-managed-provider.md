# ADR 0003: Codex managed provider qua TypeScript SDK

- Trạng thái: Accepted
- Ngày: 2026-08-09

## Bối cảnh

PatchLens cần tạo, resume, stream và cancel Codex turn trong daemon local. Bề mặt tích hợp phải được OpenAI hỗ trợ chính thức, giữ working directory trong project root và không nhận shell command tùy ý từ browser.

## Quyết định

Dùng `@openai/codex-sdk` cho managed session:

- `Codex.startThread()` tạo thread mới.
- `Codex.resumeThread()` resume bằng `providerSessionId`.
- `thread.runStreamed()` cung cấp JSONL event có cấu trúc.
- `TurnOptions.signal` dùng `AbortSignal` để cancel hoặc timeout.
- Thread dùng `workspace-write`, `approvalPolicy: never`, web search tắt và network sandbox tắt.
- Project root do daemon canonicalize.
- File ngoài root, generated directory, metadata directory và sensitive file name bị từ chối khi SDK báo file change.

## Mapping event

- `thread.started` thành Agent `session`.
- `agent_message` thành Agent `message`.
- `file_change` thành Agent `files`.
- `turn.completed` thành Agent `complete`.
- Failure thành Agent `error` có code ổn định.
- User abort thành `cancelled`; deadline abort thành `codex_timeout`.

## Giới hạn

- SDK và Codex CLI vẫn có version `0.x`; adapter giữ contract PatchLens ổn định.
- Authentication được kiểm tra ở turn đầu tiên.
- Managed daemon không hỗ trợ approval tương tác.
- `workspace-write` cho phép đọc toàn bộ project root; Codex SDK chưa cung cấp per-file read denylist cho adapter này. Không dùng managed mode trên project root chứa credential.
- Daemon restart chưa tự resume; caller có thể truyền `providerSessionId`.

## Tài liệu chính thức

- https://developers.openai.com/codex/sdk
- https://developers.openai.com/codex/noninteractive
