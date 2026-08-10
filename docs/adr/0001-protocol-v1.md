# ADR 0001: PatchLens Protocol v1

- Trạng thái: Accepted
- Ngày: 2026-08-09

## Bối cảnh

README, implementation plan và bản nháp TypeScript dùng các shape khác nhau cho `VisualSelection`, `SelectionContext` và `AgentRequest`. Type guard cũ chỉ kiểm tra prefix message nên object sai payload vẫn có thể đi qua trust boundary.

PatchLens cần contract ổn định trước khi Studio, Inspector và Daemon được triển khai độc lập.

## Quyết định

1. Type và runtime validator trong `packages/agent-protocol/src` là source of truth.
2. Protocol bắt đầu tại `schemaVersion: 1`.
3. Message qua iframe và daemon phải có `messageId`, `channelId`, `projectId` và type discriminator.
4. Agent request phải có `requestId`, `selectionId` và `projectId`.
5. Agent event phải có `requestId`, `sessionId`, `sequence` và timestamp.
6. Line dùng chỉ số bắt đầu từ 1; column dùng chỉ số bắt đầu từ 0.
7. Path trong DOM hoặc provider payload phải tương đối với project root.
8. HTML trong protocol luôn là `sanitizedHtml`; raw HTML không thuộc public contract.
9. Payload phải tuân theo giới hạn trong `PATCHLENS_PROTOCOL_LIMITS`.
10. Unknown message type, sai version hoặc sai payload phải bị từ chối trước business logic.

## Compatibility policy

- Thêm optional field được phép trong cùng major protocol version.
- Đổi nghĩa field, xóa field hoặc thêm required field cần protocol version mới.
- Consumer phải từ chối version chưa hỗ trợ thay vì đoán shape.
- Stored selection và session phải lưu `schemaVersion` để migration rõ ràng.

## Hệ quả

- Contract dài hơn nhưng trace và debug được xuyên suốt hệ thống.
- Runtime validation tạo thêm chi phí nhỏ tại boundary, đổi lại giảm lỗi và rủi ro message injection.
- Tài liệu kiến trúc phải tham chiếu protocol package, không lặp lại shape độc lập.
