# Contributing to PatchLens AI

## Prerequisites

- Node.js `>=20.19.0`.
- Corepack.
- pnpm version khai báo trong root `package.json`.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

## Development

```bash
pnpm dev
```

Local services:

- Studio: `http://127.0.0.1:4310`.
- React + Vite demo: `http://127.0.0.1:4311`.
- Daemon: `http://127.0.0.1:4312`.

## Package boundaries

- `agent-protocol` chứa public type và runtime validation.
- `compiler-vite` chỉ instrument development source và tạo manifest.
- `source-mapper` resolve PatchLens ID sang source location.
- `selection-engine` xếp hạng visual selection, không truy cập DOM trực tiếp.
- `inspector-runtime` sở hữu browser overlay và secure Studio channel.
- `studio` hiển thị preview và selection state; không sửa repository trực tiếp.
- `daemon` sở hữu project permission, agent session và file operations.

## Required checks

Trước khi đóng task:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

Security boundary cần negative test. Production build của host app không được chứa `data-patchlens-id` hoặc Inspector runtime.

Coverage toàn workspace:

```bash
pnpm test:coverage
```

## Security changes

- Đọc `docs/security.md` trước khi sửa auth, DOM capture, provider prompt, path policy, command runner hoặc capture storage.
- Thêm negative test cho origin/token mismatch, malformed protocol, traversal, symlink, secret redaction và concurrent edit liên quan.
- Không thêm arbitrary shell command từ browser payload.
- Không log daemon token, Studio token, provider credential hoặc absolute project path.

## Release

Release closure gồm mọi package transitive của `@patchlens-ai/dev`; root và demo packages luôn `private`.

```bash
pnpm check
pnpm format:check
pnpm release:check
pnpm release:dry-run
pnpm release:verify -- --tag next
```

Workflow `.github/workflows/release.yml` mặc định chạy dry-run. Chỉ chọn real publish sau khi clean install với frozen lockfile và mọi gate đạt; npm environment phải có `NPM_TOKEN`. Sau publish, chạy verifier theo [`docs/release.md`](./docs/release.md).
