# ADR 0002: React + Vite instrumentation

- Trạng thái: Accepted for MVP
- Ngày: 2026-08-09

## Bối cảnh

PatchLens cần gắn source metadata vào JSX và TSX nhưng không được thay đổi production build. Transform phải giữ source gần nguyên bản, tạo ID ổn định và không phụ thuộc output nội bộ của React plugin.

## Quyết định

1. Compiler MVP dùng Vite plugin `enforce: pre` và `apply: serve`.
2. `@babel/parser` chỉ dùng để đọc AST.
3. Metadata được chèn bằng source-position insertion, không regenerate toàn file.
4. ID được hash từ project-relative file, line, zero-based column và JSX tag name.
5. Manifest được giữ trong memory và phục vụ tại `/__patchlens/manifest` với `no-store`.
6. Existing `data-patchlens-id` không bị ghi đè.
7. File ngoài `.jsx` và `.tsx`, dependency trong `node_modules` và production build không bị instrument.

## Giới hạn MVP

- ID thay đổi khi element đổi dòng hoặc cột.
- Component wrapper không forward DOM prop vẫn dựa vào metadata của native JSX bên trong wrapper.
- Fragment không có DOM node riêng; selection resolve qua descendant source entries.
- Source map fallback và React Fiber fallback nằm sau click-selection vertical slice.

## Hệ quả

- Transform nhỏ, dễ debug và ít thay đổi formatting.
- Không có generated source map cho insertion trong bản đầu; line mapping dựa trên AST của source gốc.
- Production leak test bắt buộc trước MVP gate.
