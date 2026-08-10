# @patchlens-ai/dev

Development integration and CLI for PatchLens AI.

## React + Vite

```bash
npm install --save-dev @patchlens-ai/dev
npx patchlens init
npx patchlens doctor
npm run patchlens
```

`patchlens init` adds the Vite compiler plugin, development-only Inspector bootstrap, `patchlens.config.json`, `.patchlens/` ignore rule and `patchlens` package script. Existing files receive `.patchlens.bak` backups before modification.

## Exports

- `@patchlens-ai/dev/vite`: `patchLensVitePlugin()`.
- `@patchlens-ai/dev/next`: `withPatchLensNext()`.
- `@patchlens-ai/dev/runtime`: browser Inspector bootstrap.
- `patchlens`: `init`, `dev`, `connect`, `disconnect`, `doctor` CLI.
- `patchlens-mcp`: attached-session MCP server binary.

## Documentation

- Quickstart: https://github.com/TQCuong241/PatchLens-AI/blob/main/docs/quickstart.md
- Security and privacy: https://github.com/TQCuong241/PatchLens-AI/blob/main/docs/security.md
- Protocol: https://github.com/TQCuong241/PatchLens-AI/blob/main/docs/protocol.md

PatchLens runs only for local development. Review provider scope, screenshot privacy, diff and verification before keeping agent changes.
