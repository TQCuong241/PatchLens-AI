# PatchLens AI Roadmap

> Cập nhật: 2026-08-11
> Trạng thái: source R0–R7 và release candidate `0.1.1` đã qua clean-copy frozen offline install, Node 20.19/24, coverage, 2 Chromium E2E và 17-package artifact/consumer smoke; npm release còn chờ tạo organization `patchlens-ai`, repo administrator thêm `NPM_TOKEN`, publish và verify.

## 1. Trạng thái hiện tại

### Đã có

- pnpm workspace, TypeScript strict, ESLint, Prettier, Vitest, CI và release workflow.
- Protocol v1 có runtime validation, payload budget, correlation ID và compatibility policy.
- React + Vite compiler, Next.js compiler, Inspector, selection engine và source mapper.
- Studio, authenticated loopback daemon, patch transaction, selective undo và visual verification.
- Mock, Codex và Claude managed providers; Codex attached mode qua MCP.
- Vite/Next fixtures, unit/integration tests và Playwright Chromium E2E cho click-to-code cùng Codex/HMR.
- Quickstart, security/privacy model, ADR và extension spikes.
- `pnpm-lock.yaml`, clean-copy frozen offline install giữ nguyên hash của 190 repository file, 19-workspace build/typecheck, 176 tests và production leak checks.
- Coverage toàn source có regression floor; release dry-run kiểm 17 tarball, dependency closure, consumer lock resolution/dependency fetch rồi frozen offline install, public exports và `patchlens --help` qua binary shim.
- Post-publish verifier kiểm npm dist-tag, internal dependency closure, tarball integrity, source leak và provenance cho đủ 17 package.

### Chưa có

- npm organization/scope `patchlens-ai` chưa tồn tại; registry trả `E404 Scope not found` ngày 2026-08-11 và máy hiện tại chưa đăng nhập npm.
- GitHub environment `npm` chưa có secret `NPM_TOKEN`; tài khoản có quyền push không có quyền quản lý secret.
- npm publish cùng consumer-install verification từ registry; local tarball consumer smoke đã đạt nhưng workflow thật chưa thể publish khi thiếu secret.

### Kết luận

Critical path, clean-copy validation, local Node 20.19/24 gates, 2 Chromium E2E và release candidate `0.1.1` artifact smoke đã hoàn tất. Tag `v0.1.0` vẫn bất biến tại release candidate cũ; việc còn lại là xác nhận CI cho commit mới, tạo tag `v0.1.1`, tạo npm organization, cấp release secret, publish dist-tag `next` và verify package từ npm.

## 2. Rủi ro cần xử lý sớm

| Mức | Rủi ro | Tác động | Hướng xử lý |
| --- | --- | --- | --- |
| Cao | npm organization/scope `patchlens-ai` chưa tồn tại | Mọi publish `@patchlens-ai/*` sẽ lỗi trước khi tạo package | Tạo organization trên npm, thêm publisher và xác nhận quyền write cho scope |
| Cao | GitHub environment `npm` chưa có `NPM_TOKEN` | Workflow publish thật không thể xác thực với npm | Repo administrator thêm secret có quyền publish scope `@patchlens-ai`, không gửi token qua chat |
| Cao | SDK Codex/Claude và Next.js còn ở version thay đổi nhanh | Minor update có thể đổi event hoặc option types | Lock exact resolution, typecheck và adapter contract tests |
| Cao | Screenshot có thể chứa dữ liệu nhạy cảm dạng pixel | DOM sanitizer không bảo vệ screenshot | Hiển thị provider, giới hạn capture và yêu cầu người dùng tránh vùng nhạy cảm |
| Trung bình | Whole-repository baseline tốn RAM/thời gian | Monorepo lớn có thể vượt 20,000 file hoặc 100 MB | Giữ bounded limit và bổ sung incremental watcher khi có số liệu |
| Trung bình | Coverage toàn source mới đạt 70.19/61.77/76.34/70.47 | UI/runtime branch có thể hồi quy | Giữ regression floor 68/60/74/69, tăng test trước khi nâng floor |
| Trung bình | 31 function dài hơn 50 dòng; `App` và Inspector runtime lớn | Tăng chi phí review và thay đổi | Tách state machine/UI/runtime module sau v0.1.1, giữ behavior tests trước refactor |
| Trung bình | Package public chưa có release thực tế | Local tarball và offline consumer đã kiểm chứng nhưng chưa có bằng chứng cài từ npm | Publish dist-tag `next`, cài thử từ npm rồi mới promote stable |

## 3. Nguyên tắc thực thi

1. Làm vertical slice chạy được trước khi mở rộng package.
2. Dùng mock provider trước Codex để tách lỗi UI, protocol và agent integration.
3. Mọi boundary giữa iframe, Studio và Daemon phải có runtime validation.
4. Instrumentation chỉ tồn tại trong development build.
5. Mọi thay đổi file từ agent phải nằm trong patch transaction có baseline và undo an toàn.
6. Next.js, Claude và website cross-origin nằm sau React + Vite MVP.

## 4. Milestone roadmap

### R0 — Engineering Baseline

**Mục tiêu:** repo cài, build, typecheck và test được bằng command thống nhất.

Phạm vi:

- Hoàn thiện workspace tối thiểu cho Studio, Daemon, demo và các package thuộc critical path.
- Thêm lockfile, lint, format, Vitest và CI.
- Chốt protocol v1, runtime schema, message version và correlation ID.
- Đồng bộ README, implementation plan và source contract.

Điều kiện hoàn thành:

- `corepack pnpm install --frozen-lockfile` chạy được trên máy mới.
- `pnpm typecheck`, `pnpm build` và `pnpm test` đều xanh.
- Invalid Inspector message bị từ chối bằng runtime validation.
- Root `pnpm dev` mở được demo flow tối thiểu hoặc báo lỗi cấu hình rõ ràng.

### R1 — Click Visual-to-Code Slice

**Mục tiêu:** click một element trong React + Vite demo và nhận đúng component, file, line, column.

Phạm vi:

- Vite compiler plugin inject `data-patchlens-id` trong development.
- Source manifest với ID ổn định trong dev session.
- Inspector hover và click overlay không làm đổi layout.
- Source Mapper và click selection resolver.
- Secure iframe message channel.
- Demo fixtures cho element trực tiếp, wrapper, Fragment, list và conditional render.

Điều kiện hoàn thành:

- Click fixtures chuẩn trả về source location chính xác.
- Production build không chứa `data-patchlens-id` hoặc Inspector runtime.
- Playwright test chứng minh end-to-end click selection.

### R2 — Drag Selection và Anchored Chat

**Mục tiêu:** chọn vùng nhiều element và mở chat đúng selection bằng mock provider.

Phạm vi:

- Drag rectangle, intersection filtering và candidate ranking.
- Confidence `exact`, `likely`, `visual-only` có rule rõ ràng.
- Studio shell, iframe preview và chuyển đổi tọa độ.
- Anchored chat, selection thread và mock event streaming.
- Context builder cho sanitized DOM, styles tối thiểu và console errors.

Điều kiện hoàn thành:

- Drag trên demo trả về candidate hợp lý và ổn định.
- Chat giữ đúng `selectionId` qua nhiều message.
- Scroll, resize và HMR không làm mất hoặc lệch selection overlay.

### R3 — Local Daemon và Safe Patch Transaction

**Mục tiêu:** Studio giao tiếp với daemon local, theo dõi thay đổi file và undo riêng thay đổi của agent.

Phạm vi:

- Daemon bind `127.0.0.1`, local session token và project-root allowlist.
- HTTP API và SSE hoặc WebSocket cho streaming.
- Agent Session Registry và selection context store.
- File watcher, diff generation và HMR feedback.
- Patch transaction có baseline, conflict detection và selective undo.
- Command allowlist cho test, lint và verification.

Điều kiện hoàn thành:

- Website khác không thể gọi daemon nếu thiếu token.
- Path traversal và symlink escape bị chặn.
- Undo không ghi đè thay đổi người dùng tạo sau transaction.
- Mock provider có thể tạo patch, hiện diff và undo thành công.

### R4 — Codex Managed Session

**Mục tiêu:** một Codex session do PatchLens quản lý nhận selection context, sửa file và stream kết quả.

Phạm vi:

- Spike bề mặt tích hợp Codex được hỗ trợ chính thức trong môi trường mục tiêu.
- `CodingProvider` interface và Codex adapter.
- Create, resume, cancel, dispose và error mapping.
- Structured prompt, scope policy và scope-expansion report.
- Correlation giữa agent event, request và patch transaction.

Điều kiện hoàn thành:

- Một request từ anchored chat sửa đúng fixture đã chọn.
- Studio hiển thị trạng thái, file thay đổi, diff và lỗi có cấu trúc.
- Cancel không để session hoặc transaction ở trạng thái treo.

### R5 — React + Vite MVP

**Mục tiêu:** cài PatchLens vào repository React + Vite mới bằng command flow công khai.

Phạm vi:

- `@patchlens-ai/dev` và CLI `init`, `dev`, `doctor`.
- Config discovery, port handling và error diagnostics.
- Before/after capture, console regression check và component existence check.
- Security, privacy, payload-limit và dirty-repo test suite.
- Tài liệu cài đặt, troubleshooting và limitations.

Điều kiện hoàn thành:

- Command flow trong README chạy được trên sample repo sạch.
- MVP acceptance criteria trong README có automated evidence.
- Production build của host app không chứa PatchLens runtime.

### R6 — MCP Attached Session

**Mục tiêu:** Codex hoặc agent bên ngoài lấy active selection qua MCP mà không cần PatchLens sở hữu session.

Phạm vi:

- MCP server và selection tools.
- `patchlens connect`, `disconnect` và `doctor`.
- Permission, session binding và stale-selection handling.
- Skill hoặc plugin hướng dẫn agent sử dụng context.

Điều kiện hoàn thành:

- Agent ngoài Studio lấy đúng active selection và source context.
- Tool không đọc project khác hoặc selection hết hạn.

### R7 — Mở rộng sau MVP

- Claude provider adapter.
- Next.js compiler integration và server/client component boundaries.
- Browser extension hoặc reverse proxy cho cross-origin preview.
- Visual regression nâng cao, design-token awareness và multi-selection workflow.
- Persistent history bằng SQLite nếu resume/history trở thành nhu cầu thật.

## 5. Trạng thái validation theo milestone

| Milestone | Trạng thái | Bằng chứng chính | Còn lại |
| --- | --- | --- | --- |
| R0 | Đạt | Clean-copy frozen offline install; Node 20.19/24 `pnpm check`; recursive workspace tests; coverage floor | Không |
| R1 | Đạt | Compiler/manifest tests, Inspector jsdom tests, Vite production leak check và Playwright click selection | Không |
| R2 | Đạt | Selection ranking, multi-select, remount, Studio message-channel và context tests | Không |
| R3 | Đạt | Daemon auth/origin, project path, transaction conflict/undo và lifecycle tests | Không |
| R4 | Đạt | Codex adapter contract, daemon managed-edit integration, cancel/dispose/error tests và Playwright Codex/HMR | Không |
| R5 | Đạt source và artifact gate | CLI init/dev/doctor tests, Vite/Next production builds, visual verifier tests, 17-package consumer smoke | Publish chờ release gate |
| R6 | Đạt | MCP session/service, permission, stale selection và source-boundary tests | Không |
| R7 | Đạt theo phạm vi | Claude adapter, Next compiler, cross-origin design và SQLite evaluation | Refactor/coverage tăng dần hậu v0.1.1 |

## 6. Thứ tự critical path

1. Protocol v1 và engineering baseline.
2. React + Vite demo fixtures.
3. Compiler instrumentation và source manifest.
4. Inspector click selection và source mapping.
5. Studio, drag selection và mock chat.
6. Daemon, transaction và safe undo.
7. Codex managed adapter.
8. CLI, verification và MVP hardening.
9. MCP, Claude và Next.js.

Backlog chi tiết nằm tại [`TASKS.md`](./TASKS.md).
