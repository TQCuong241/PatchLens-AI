# PatchLens AI Release Runbook

> Cập nhật: 2026-08-11
> Phạm vi: publish các package public bằng GitHub Actions, provenance và npm dist-tag.

## 1. Invariant

- Chỉ publish từ annotated Git tag trỏ tới commit đã qua CI.
- Workflow từ chối branch, lightweight tag, tag khác `v${package.version}` và tag không trỏ đúng `GITHUB_SHA`.
- Không force-push hoặc di chuyển tag đã công bố.
- Không gửi npm token qua chat, commit, log hoặc command-line argument.
- Mọi package public phải dùng cùng version và giữ `publishConfig.provenance=true`.
- Lần phát hành đầu tiên cần npm access token; trusted publishing chỉ thay thế token sau khi package đã tồn tại và publisher đã được cấu hình trên npm.

## 2. Credential

Trước lần publish đầu tiên:

- Đăng nhập npm bằng tài khoản publisher; không gửi password, OTP hoặc token qua chat.
- Tạo npm organization `patchlens-ai` và thêm publisher có quyền write cho scope `@patchlens-ai`.
- Xác nhận `npm org ls patchlens-ai` trả danh sách thành viên thay vì `E404 Scope not found`.

Npm publisher cần:

- Quyền publish scope `@patchlens-ai`.
- Granular access token có quyền read/write cho package release.
- Bypass 2FA cho automation nếu chính sách npm yêu cầu.

Repo administrator thêm token vào GitHub environment `npm` với tên `NPM_TOKEN`. Dùng GitHub UI hoặc đăng nhập `gh` bằng tài khoản có quyền quản lý environment rồi chạy:

```bash
gh secret set NPM_TOKEN --env npm --repo TQCuong241/PatchLens-AI
```

Command phải đọc secret từ prompt hoặc stdin; không đặt token trực tiếp trong command history.

## 3. Preflight

```bash
git fetch --prune --tags origin
git status --short --branch
git show --no-patch v0.1.1
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test:coverage
corepack pnpm test:e2e
corepack pnpm release:dry-run
```

`release:dry-run` phải kiểm đủ 17 tarball, dependency closure, source/test leak, offline consumer install, public exports và binary `patchlens --help`. Xác nhận CI Node `20.19.0`, Node `24` và Chromium E2E xanh trên commit được tag.

## 4. Cloud dry-run

```bash
gh workflow run release.yml \
  --repo TQCuong241/PatchLens-AI \
  --ref v0.1.1 \
  -f dry_run=true \
  -f tag=next
```

Chỉ tiếp tục khi workflow checkout đúng annotated tag, `release:ref-check` đạt và dry-run tạo/cài thử đủ 17 tarball.

## 5. Publish

```bash
gh workflow run release.yml \
  --repo TQCuong241/PatchLens-AI \
  --ref v0.1.1 \
  -f dry_run=false \
  -f tag=next
```

Không chạy song song hai workflow publish cho cùng version. Real publish luôn chạy lại toàn bộ `release:dry-run` trước `pnpm publish`.

## 6. Verify

Sau khi workflow thành công:

```bash
corepack pnpm release:verify -- --tag next
```

Verifier kiểm tra toàn bộ 17 package:

- Version và npm dist-tag.
- Internal dependency closure không còn `workspace:`.
- Tarball SHA-1 và Subresource Integrity.
- `package/package.json`, thư mục `dist`, source/test leak và package identity.
- Npm provenance endpoint có ít nhất một attestation.

Chỉ đóng `REL-001` khi command trả JSON có `ok: true` và đủ 17 package.

## 7. Failure recovery

- Nếu auth fail trước package đầu tiên: sửa environment secret rồi dispatch lại cùng tag.
- Nếu publish dừng giữa chừng: không đổi hoặc ghi đè version đã tồn tại. Kiểm tra package nào đã publish, sửa nguyên nhân và chỉ hoàn tất package còn thiếu.
- Không promote dist-tag `latest` khi `release:verify -- --tag next` còn lỗi.
