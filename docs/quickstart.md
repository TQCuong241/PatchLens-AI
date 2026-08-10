# PatchLens AI Quickstart

Quickstart này dùng một repository React + Vite TypeScript mới và luồng package `@patchlens-ai/dev`.

## Yêu cầu

- Node.js `>=20.19.0`.
- npm, pnpm qua Corepack, Yarn hoặc Bun.
- Ba cổng loopback trống: Studio `4310`, preview `4311`, daemon `4312`.
- Codex hoặc Claude đã xác thực nếu dùng managed provider thật.

## 1. Tạo ứng dụng React + Vite

```bash
npm create vite@latest patchlens-demo -- --template react-ts
cd patchlens-demo
npm install
npm install --save-dev @patchlens-ai/dev
```

## 2. Khởi tạo PatchLens

```bash
npx patchlens init
```

`patchlens init` thực hiện các thay đổi idempotent sau:

- Thêm script `patchlens` vào `package.json`.
- Thêm `patchLensVitePlugin()` vào literal `plugins` array của Vite config.
- Thêm Inspector bootstrap chỉ chạy khi `import.meta.env.DEV`.
- Tạo `patchlens.config.json` với provider `mock`.
- Thêm `.patchlens/` vào `.gitignore`.
- Tạo file `.patchlens.bak` trước khi ghi đè file đã tồn tại.

Xem trước thay đổi mà không ghi file:

```bash
npx patchlens init --dry-run
```

Nếu Vite config không có literal `plugins: []`, thêm integration thủ công:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { patchLensVitePlugin } from '@patchlens-ai/dev/vite';

export default defineConfig({
  plugins: [patchLensVitePlugin(), react()],
});
```

Trong application entry:

```ts
if (import.meta.env.DEV) {
  void import('@patchlens-ai/dev/runtime').then(({ installPatchLensInspector }) => {
    void installPatchLensInspector();
  });
}
```

## 3. Kiểm tra cấu hình

```bash
npx patchlens doctor
```

Doctor kiểm tra Node, package manager, project root, Vite hoặc Next compiler integration, Inspector bootstrap, port, host URL, provider, Codex MCP attachment và production leak.

## 4. Chạy PatchLens

```bash
npm run patchlens
```

Command khởi động host dev server, daemon và Studio trên loopback. Mở URL `PatchLens Studio` có token được in trong terminal.

Trong Studio:

1. Bật selection mode.
2. Hover rồi click element, hoặc drag vùng cần sửa.
3. Dùng `Shift` khi click để gom nhiều element vào cùng selection.
4. Nhập yêu cầu thay đổi.
5. Xem stream trạng thái, file thay đổi, diff, before/after và verification.
6. Dùng undo để hoàn tác riêng transaction của agent khi không có concurrent edit.

## 5. Chọn managed provider

Sửa `provider` trong `patchlens.config.json`:

```json
{
  "provider": "codex"
}
```

Giá trị built-in:

- `mock`: không gọi dịch vụ ngoài; dùng để kiểm tra UI và protocol.
- `codex`: managed session qua `@openai/codex-sdk`.
- `claude`: managed session qua `@anthropic-ai/claude-agent-sdk`.

Codex managed mode có quyền đọc toàn bộ project root. Dùng project copy đã loại `.env`, private key và credential; file-change denylist không phải read sandbox.

Managed provider nhận instruction, source context, sanitized DOM, computed-style allowlist, console context và screenshot nếu capture được. Đọc `docs/security.md` trước khi dùng với repository hoặc giao diện nhạy cảm.

## 6. Kết nối Codex qua MCP

Attached mode khác managed mode. Attached mode giữ cuộc chat trong Codex bên ngoài PatchLens và cấp MCP tools cho active selection.

```bash
npx patchlens connect codex
npm run patchlens
```

Sau phiên làm việc:

```bash
npx patchlens disconnect codex
```

`connect` kiểm tra conflict trước khi ghi Codex MCP config. `disconnect` chỉ xóa server còn khớp record PatchLens, không xóa cấu hình đã bị sửa ngoài PatchLens.

## 7. Next.js development

`patchlens init` hiện tự động hóa React + Vite. Next.js cần wiring thủ công:

```ts
import { withPatchLensNext } from '@patchlens-ai/dev/next';

export default withPatchLensNext({ reactStrictMode: true });
```

Tạo `instrumentation-client.ts`:

```ts
if (process.env.NODE_ENV === 'development') {
  void import('@patchlens-ai/dev/runtime').then(({ installPatchLensInspector }) => {
    void installPatchLensInspector({ manifestEndpoint: false });
  });
}
```

Next integration hỗ trợ Turbopack rules và webpack fallback. Production loader trả source nguyên bản; production build vẫn phải chạy leak check.

## 8. Xử lý lỗi thường gặp

### Port đang bận

Đổi `host.url`, `studio.port`, `daemon.port` trong `patchlens.config.json`, đồng thời cập nhật host command để dùng cùng port. `host.url` phải là plain loopback HTTP origin, không chứa credential, path, query hoặc fragment.

### Preview không sẵn sàng

Chạy host app riêng, đặt `host.start` thành `false`, rồi xác nhận `host.url` là URL loopback đang phản hồi.

### Không tìm thấy source

Xác nhận compiler plugin đứng trong Vite hoặc Next config, runtime chỉ load ở development, và selected JSX/TSX không nằm trong generated output hoặc `node_modules`.

### Provider không xác thực

Xác thực provider bằng flow chính thức của Codex hoặc Claude, rồi tạo session mới. PatchLens không lưu API key vào config, SQLite hoặc browser storage.

### Production leak

Xóa output cũ, build lại, rồi chạy:

```bash
npx patchlens doctor
```

Production output không được chứa `data-patchlens-id`, `data-patchlens-source`, Inspector runtime hoặc PatchLens connection query parameters.

## 9. Chạy repository PatchLens từ source

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Demo Vite nằm tại `examples/react-vite-demo`; demo Next nằm tại `examples/next-app-demo`.
