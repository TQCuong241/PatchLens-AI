# PatchLens AI Tasks

> Cập nhật: 2026-08-10
> Quy ước ưu tiên: `P0` chặn critical path, `P1` cần cho MVP, `P2` mở rộng.
> Trạng thái: `[x]` đã qua DoD, `[~]` đã qua source/unit gate nhưng còn phụ thuộc browser hoặc release gate, `[ ]` chưa triển khai.

## Đã hoàn thành

- [x] `BASE-001` Tạo pnpm workspace root.
- [x] `BASE-002` Bật TypeScript strict và `noUncheckedIndexedAccess`.
- [x] `BASE-003` Tạo bản nháp `@patchlens-ai/agent-protocol`.
- [x] `BASE-004` Viết README sản phẩm và implementation plan.

## Gate còn lại

1. Repo administrator thêm `NPM_TOKEN` vào GitHub environment `npm`; tài khoản có quyền push không thể quản lý environment secret.
2. Dispatch workflow `Release` trên tag `v0.1.0` với `dry_run=false` và dist-tag `next`.
3. Chỉ đóng `REL-001` sau khi cài thử 17 package từ npm và verify version, dependency closure cùng provenance.

## Bằng chứng validation — 2026-08-10

- `corepack pnpm install --frozen-lockfile --offline`: xanh trong workspace hiện tại.
- Clean-copy chứa đúng 184 source file: `corepack pnpm install --frozen-lockfile --offline` không download package, giữ nguyên toàn bộ source hash; `corepack pnpm check` tiếp tục xanh với 170/170 tests.
- `corepack pnpm check`: xanh; 19 workspace build, typecheck toàn workspace/E2E và root test suite đều đạt.
- `corepack pnpm -r --if-present test`: xanh cho toàn bộ 19 workspace có script.
- `corepack pnpm test:coverage`: xanh; 30 test files, 170 tests. Coverage toàn source: 70.2% statements, 61.8% branches, 76.34% functions, 70.48% lines; regression floor lần lượt 68%, 60%, 74%, 69%.
- Vite và Next.js production builds: xanh; leak check không thấy `data-patchlens-id`, Inspector runtime hoặc PatchLens manifest.
- `corepack pnpm release:dry-run`: xanh; build và kiểm 17 tarball, dependency closure, `dist` presence, source/test leak.
- `corepack pnpm exec playwright test --list`: nhận đủ 2 browser tests.
- `corepack pnpm test:e2e`: xanh; 2 Chromium tests xác nhận click-to-source và Codex managed edit qua Vite HMR, runner thoát sạch và không rò port `4311`.
- URL boundary regression: CLI host và MCP daemon chỉ chấp nhận plain loopback HTTP origin; credential, path, query và fragment đều bị từ chối.
- GitHub CI run `31404959642`: xanh trên Node `20.19.0`, Node `24` và Chromium E2E sau khi đổi Next fixture sang `next.config.mjs`.
- Annotated tag `v0.1.0` trỏ tới commit `9d9494d`; GitHub Release dry-run `31405321455` xanh trên chính tag này.
- npm registry preflight: cả 17 package version `0.1.0` chưa tồn tại; GitHub environment `npm` đã được tạo nhưng chưa có `NPM_TOKEN`.

## P0 — Engineering Baseline

- [x] `FND-001` Tạo và commit `pnpm-lock.yaml`; xác nhận frozen offline install bằng Corepack trên clean-copy độc lập.
- [x] `FND-002` Tạo workspace tối thiểu: `apps/studio`, `apps/daemon`, `examples/react-vite-demo`.
- [x] `FND-003` Tạo package critical path: `compiler-vite`, `inspector-runtime`, `selection-engine`, `source-mapper`.
- [x] `FND-004` Thêm Vitest config, script test cho từng package và root coverage command.
- [x] `FND-005` Thêm ESLint, formatter và command `lint`, `format:check`.
- [x] `FND-006` Thêm CI chạy install frozen, typecheck, lint, test và build.
- [x] `FND-007` Sửa root `dev` để chỉ gọi workspace tồn tại và báo lỗi port/process rõ ràng.
- [x] `FND-008` Thêm `CONTRIBUTING.md` với setup, command và package boundaries.

## P0 — Protocol v1

- [x] `PRO-001` Chọn source of truth cho contract và ghi ADR ngắn.
- [x] `PRO-002` Đồng bộ `VisualSelection`, `SelectionContext`, `AgentRequest` giữa source và tài liệu.
- [x] `PRO-003` Thêm `schemaVersion` cho mọi message đi qua iframe hoặc daemon.
- [x] `PRO-004` Thêm `projectId`, `selectionId`, `requestId` và `transactionId` tại boundary cần thiết.
- [x] `PRO-005` Thay type guard prefix bằng runtime discriminated schema validation.
- [x] `PRO-006` Thêm test cho unknown type, thiếu payload, sai field type, extra-large payload và malformed object.
- [x] `PRO-007` Định nghĩa event `error`, `cancelled`, `progress`, `diff`, `verification` và terminal state.
- [x] `PRO-008` Sửa `ProviderId` để giữ autocomplete cho provider built-in nhưng vẫn mở rộng được.
- [x] `PRO-009` Chuẩn hóa timestamp ISO 8601, rectangle constraints và viewport constraints.
- [x] `PRO-010` Định nghĩa backward-compatibility policy cho protocol trước khi publish package.

## P0 — Security và Privacy Contract

- [x] `SEC-001` Định nghĩa DOM sanitization policy; loại password, token, hidden input và giá trị nhạy cảm.
- [x] `SEC-002` Đặt payload budget cho HTML, text, computed styles, console errors và screenshot.
- [x] `SEC-003` Định nghĩa origin, token và handshake cho Studio với Inspector iframe.
- [x] `SEC-004` Định nghĩa project-root canonicalization, symlink policy và path traversal tests.
- [x] `SEC-005` Định nghĩa log redaction cho secret, absolute path và provider payload.
- [x] `SEC-006` Định nghĩa command allowlist; không nhận shell command tùy ý từ browser payload.

## P0 — React + Vite Visual-to-Code

- [x] `VTC-001` Spike Babel, SWC và Vite AST transform; chọn phương án ổn định cho JSX/TSX metadata.
- [x] `VTC-002` Thiết kế ID ổn định trong dev session và collision test.
- [x] `VTC-003` Inject `data-patchlens-id` chỉ trong development build.
- [x] `VTC-004` Sinh source manifest với component, file, line, column và tag name.
- [x] `VTC-005` Thêm production leak test cho metadata và Inspector runtime.
- [x] `VTC-006` Tạo demo fixtures: native element, custom component, wrapper, Fragment, list, conditional và Portal.
- [x] `VTC-007` Tạo Inspector overlay bằng Shadow DOM hoặc isolated root.
- [x] `VTC-008` Thêm hover highlight không gây layout shift hoặc pointer interference.
- [x] `VTC-009` Thêm click selection và nearest PatchLens ID lookup.
- [x] `VTC-010` Tạo Source Mapper từ ID sang manifest entry.
- [x] `VTC-011` Gửi selection qua secure message channel và runtime schema.
- [x] `VTC-012` Thêm Playwright test click element và xác nhận file/line/component.

## P1 — Drag Selection và Studio

- [x] `SEL-001` Thêm pointer drag rectangle và normalize tọa độ.
- [x] `SEL-002` Lọc element quá nhỏ, invisible, overlay-owned hoặc bị che hoàn toàn.
- [x] `SEL-003` Xếp hạng candidate theo coverage, specificity và common component ancestor.
- [x] `SEL-004` Viết rule và test cho confidence `exact`, `likely`, `visual-only`.
- [x] `SEL-005` Theo dõi scroll, resize, DOM mutation và HMR remount.
- [x] `STD-001` Tạo Studio shell với toolbar, route, viewport và provider state.
- [x] `STD-002` Embed preview và chuyển tọa độ iframe sang Studio.
- [x] `STD-003` Tạo anchored chat placement dưới, trên hoặc cạnh selection.
- [x] `STD-004` Lưu thread theo `selectionId`; xử lý selection stale sau HMR.
- [x] `STD-005` Tạo mock provider stream status, message, files, complete và error.
- [x] `STD-006` Hiển thị source location, confidence và cảnh báo visual-only.
- [x] `CTX-001` Tạo sanitized DOM subtree builder.
- [x] `CTX-002` Chọn computed-style allowlist tối thiểu và test payload size.
- [x] `CTX-003` Thu console error có timestamp và baseline trước request.

## P1 — Daemon và Patch Safety

- [x] `DMN-001` Tạo daemon bind `127.0.0.1` với health endpoint versioned.
- [x] `DMN-002` Tạo local session token và authenticated Studio handshake.
- [x] `DMN-003` Tạo project registry với explicit user approval.
- [x] `DMN-004` Tạo HTTP API ngắn và SSE hoặc WebSocket cho agent events.
- [x] `DMN-005` Tạo Agent Session Registry và lifecycle cleanup.
- [x] `DMN-006` Lưu active selection context theo project và session.
- [x] `DMN-007` Theo dõi file changes và liên kết HMR feedback.
- [x] `PAT-001` Chụp baseline file trước request mà không phụ thuộc Git clean state.
- [x] `PAT-002` Sinh diff giới hạn trong file agent đã thay đổi.
- [x] `PAT-003` Phát hiện user edit phát sinh sau baseline.
- [x] `PAT-004` Thực hiện selective undo; không dùng `git reset --hard`.
- [x] `PAT-005` Cảnh báo scope expansion ngoài selected component và planned files.
- [x] `PAT-006` Test dirty repository, concurrent edit, file rename, delete và binary file.

## P1 — Codex Managed Session

- [x] `CDX-001` Xác minh integration surface Codex được hỗ trợ chính thức; ghi ADR và giới hạn.
- [x] `CDX-002` Chốt `CodingProvider` interface từ mock provider behavior.
- [x] `CDX-003` Implement detect, create, send, cancel, dispose và resume nếu được hỗ trợ.
- [x] `CDX-004` Map provider event sang protocol event ổn định.
- [x] `CDX-005` Tạo structured prompt từ selection, source, DOM, styles và scope policy.
- [x] `CDX-006` Gắn request với patch transaction và file-change report.
- [x] `CDX-007` Xử lý timeout, provider unavailable, auth failure, cancel và partial patch.
- [x] `CDX-008` E2E test request sửa fixture đã chọn và preview cập nhật qua HMR.

## P1 — MVP Packaging và Verification

- [x] `CLI-001` Tạo `@patchlens-ai/dev` làm package người dùng cài.
- [x] `CLI-002` Tạo `patchlens init` với config idempotent và backup khi sửa file.
- [x] `CLI-003` Tạo `patchlens dev` để khởi động hoặc kết nối host dev server, daemon và Studio.
- [x] `CLI-004` Tạo `patchlens doctor` cho Node, pnpm, port, config, provider và production-leak checks.
- [x] `VER-001` Chụp selected region trước và sau thay đổi.
- [x] `VER-002` Phát hiện console/runtime error mới sau HMR.
- [x] `VER-003` Kiểm tra selected component còn tồn tại và route vẫn render.
- [x] `VER-004` Hiển thị before/after, diff, commands đã chạy và verification result.
- [x] `DOC-001` Viết quickstart từ repository React + Vite sạch.
- [x] `DOC-002` Viết security model, data sent to provider và limitations.
- [~] `REL-001` Chuyển package cần publish khỏi `private`, thêm metadata và release workflow khi MVP đạt gate.

## P2 — MCP và Mở rộng

- [x] `MCP-001` Tạo MCP server với active-selection resource lifetime rõ ràng.
- [x] `MCP-002` Implement `get_active_selection`, `get_selection_context` và `get_source_context`.
- [x] `MCP-003` Implement capture, console error và visual verification tools.
- [x] `MCP-004` Tạo `connect`, `disconnect`, permission audit và stale-session handling.
- [x] `EXT-001` Tạo Claude provider adapter sau khi Codex contract ổn định.
- [x] `EXT-002` Spike Next.js instrumentation cho server/client boundary.
- [x] `EXT-003` Thiết kế cross-origin mode bằng browser extension hoặc reverse proxy.
- [x] `EXT-004` Đánh giá SQLite chỉ khi cần persistent resume và history.

## Definition of Done chung

Một task chỉ được đóng khi:

- Có code hoặc tài liệu đã review.
- Có test cho behavior chính và lỗi quan trọng nếu task tạo behavior.
- Typecheck, lint và test liên quan chạy xanh.
- Public contract hoặc command có tài liệu.
- Security boundary có negative test.
- Không đưa PatchLens runtime vào production build của host app.
