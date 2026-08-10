# Security and Privacy Model

PatchLens trao quyền đọc và sửa repository cho coding provider. Daemon, browser preview và provider được tách thành các trust boundary riêng; dữ liệu từ DOM, console, source và user instruction luôn được xem là untrusted input.

## Phạm vi bảo vệ

Security model tập trung vào local development:

- Daemon và Studio chỉ bind `127.0.0.1`.
- Preview phải dùng plain loopback HTTP origin trong MVP; URL có credential, path, query hoặc fragment bị từ chối.
- Daemon API yêu cầu random bearer token cho mọi endpoint ngoài public `/health`.
- Studio nhận random access token qua query login, redirect bỏ token khỏi URL, sau đó dùng cookie `HttpOnly; SameSite=Strict`.
- Browser origin phải khớp allowlist trước token validation.
- Studio và Inspector chỉ dùng explicit `postMessage` origin, channel ID, project ID và runtime schema validation.
- Project root được canonicalize bằng `realpath` trước mọi transaction hoặc managed session.

PatchLens không phải sandbox cho browser, dependency hoặc repository độc hại. Chỉ dùng với project và dev server bạn tin cậy.

## Dữ liệu được thu thập

Mỗi selection có thể chứa:

- Route, viewport và rectangle.
- PatchLens element IDs, tag name và text đã giới hạn.
- Source location tương đối với project root.
- Source file ranges liên quan.
- Sanitized DOM subtree.
- Computed-style allowlist và CSS custom properties dùng như design tokens.
- Accessibility summary.
- Console warning/error mới, có timestamp.
- Screenshot vùng chọn khi browser capture thành công.
- User instruction, scope policy và verification request.

Protocol v1 áp dụng budget chính:

| Payload                |      Giới hạn |
| ---------------------- | ------------: |
| Text hoặc instruction  |  20,000 ký tự |
| Sanitized HTML         | 200,000 ký tự |
| Console entries        |           100 |
| Computed-style entries |           100 |
| Related source files   |           100 |
| Screenshot bytes       |     2,000,000 |
| Files trong event      |           500 |
| Diff                   | 500,000 ký tự |

Runtime validator từ chối unknown message type, sai protocol version, malformed object, invalid rectangle/viewport và payload vượt budget trước business logic.

## DOM sanitization

Inspector clone DOM trước khi gửi context và:

- Loại `script`, `style`, `template`, `noscript`.
- Loại password input, hidden input và form control có `name`, `id` hoặc `autocomplete` nhạy cảm.
- Loại inline event handler và `srcdoc`.
- Xóa nội dung `textarea` và `select`.
- Redact `value`, authorization, cookie, CSRF, password, secret và token attributes.
- Redact bearer token, API-key-like text, credential assignment và absolute file URL trong text, style, attribute và console capture.
- Loại `data-patchlens-source` khỏi provider DOM context.

Sanitization không thể nhận diện mọi secret tùy biến. Không chọn vùng đang hiển thị credential, private key, customer data hoặc thông tin cá nhân.

## Screenshot privacy

Screenshot là pixel data nên không hưởng DOM sanitization. Nó có thể chứa text, avatar, email, token hoặc dữ liệu khác đang hiển thị.

- Capture chỉ giới hạn vào selected region khi browser hỗ trợ.
- MIME type, base64, byte length và image signature được kiểm tra.
- Capture được lưu dưới `.patchlens/captures` trong project root.
- Runtime giữ tối đa 8 capture mỗi selection và 256 capture mỗi session.
- `.patchlens/` phải nằm trong `.gitignore`.
- Studio tải capture qua authenticated daemon endpoint và thu hồi blob URL khi ảnh bị thay thế hoặc Studio unmount.

Caller có thể đặt `captureAfterChange` thành `false` để bỏ before/after verification capture. Không chọn vùng đang hiển thị dữ liệu nhạy cảm vì Inspector selection capture vẫn phụ thuộc runtime policy.

## Dữ liệu gửi tới provider

### Mock

Không gọi dịch vụ ngoài. Mock chỉ stream event deterministic trong local process.

### Codex managed session

Codex nhận structured prompt và optional local screenshot path. Adapter cấu hình:

- `workspace-write` sandbox trong canonical project root.
- Sandbox cho phép đọc mọi file dưới project root; Codex SDK không cung cấp per-file read denylist cho mode này.
- Network access tắt.
- Approval policy `never` để turn không treo chờ browser-originated prompt.
- Web search tắt.
- File-change report cho generated directory, metadata directory và sensitive file name bị từ chối.
- Project path và credential pattern được redact khỏi provider error.

Không đặt credential hoặc private key trong project root dùng cho Codex managed mode. Prompt yêu cầu agent không đọc file nhạy cảm nhưng prompt không phải filesystem boundary.

### Claude managed session

Claude nhận cùng context class và chỉ được cấp `Read`, `Glob`, `Grep`, `Edit`, `Write`.

- `Bash`, web, MCP, subagent và worktree tools bị chặn.
- Mỗi tool input được authorize bằng canonical path và symlink policy.
- `.git`, `.patchlens`, `.claude`, `node_modules` và sensitive file names bị chặn.
- SDK settings sources và auto-memory bị tắt.
- Provider error được redact trước khi stream về Studio.

Provider credentials do SDK hoặc provider environment quản lý. PatchLens không ghi API key vào `patchlens.config.json`, browser storage, capture store hoặc session descriptor.

## Patch transaction safety

Trước managed turn, daemon chụp bounded in-memory baseline của regular text files trong repository, không phụ thuộc Git clean state.

- Planned files được snapshot trước provider execution.
- Scope-expanded files dùng repository baseline đã chụp trước turn.
- Path traversal, absolute path, protected root, symlink escape, binary file và oversized file bị từ chối.
- Diff chỉ bao gồm file thuộc transaction scope.
- Undo chỉ chạy khi current file hash vẫn khớp post-agent state.
- Concurrent user edit tạo conflict; PatchLens không ghi đè.
- Undo không dùng `git reset --hard`.

Baseline mặc định dừng ở 20,000 file, 100 MB tổng text và 1 MB mỗi file. Repository lớn hơn cần giảm scope hoặc tăng limit bằng API nội bộ sau security review.

## Verification command safety

Browser chỉ gửi command ID: `typecheck`, `lint`, `test`, `build`.

- Daemon map ID sang package-manager command do local project xác định.
- Không nhận shell command hoặc arguments tùy ý từ browser payload.
- Process chạy với `shell: false`, bounded output và timeout.
- Command failure trở thành verification failure.

## MCP attached session

Session descriptor chứa daemon URL, bearer token, project binding, PID và thời gian hết hạn 24 giờ. MCP server chỉ chấp nhận plain loopback HTTP origin, đồng thời từ chối URL có credential/path/query/fragment, malformed descriptor, expired descriptor, stale PID/session và project mismatch.

Attached coding agent vẫn giữ permission model riêng. PatchLens MCP chỉ cung cấp selection/context/capture/verification tools; nó không thu hồi quyền shell hoặc filesystem mà agent đã có ngoài PatchLens.

## Logging and retention

- Browser console capture chỉ giữ bounded warning/error entries trong memory.
- Daemon token và provider credential không được log.
- CLI in one-time Studio login URL có access token để người dùng mở giao diện. Xem terminal output và browser history của URL này là dữ liệu nhạy cảm.
- Provider và daemon errors redact project root, bearer token, API-key-like value và credential assignment.
- Session, thread và selection history hiện chỉ sống trong memory.
- SQLite persistence chưa bật; xem `docs/spikes/sqlite-history.md`.

## Giới hạn đã biết

- Same-origin local preview là mode hỗ trợ; cross-origin extension mới ở mức thiết kế.
- Malicious dev server có thể cố giả selection hoặc console data. Provider prompt coi dữ liệu này là untrusted nhưng prompt injection không thể được loại bỏ tuyệt đối.
- Managed provider vẫn là coding agent có quyền sửa file trong scope. Luôn xem diff và verification trước khi giữ thay đổi.
- Codex managed sandbox không chặn đọc từng file trong project root; dùng project copy đã loại secret nếu repository chứa credential.
- Whole-repository baseline tăng thời gian và RAM trên monorepo lớn.
- Production leak checks dựa trên forbidden marker scan; chúng không thay thế review bundle và deployment artifact.
- Capture retention chỉ áp dụng trong process hiện tại; crash có thể để file capture cũ trong `.patchlens/captures` cho đến khi người dùng xóa.

## Báo cáo vấn đề

Không đưa secret thật vào issue, fixture hoặc screenshot. Mô tả reproduction bằng repository tối thiểu và giá trị giả đã redact.
