# Next.js instrumentation spike

## Decision

PatchLens supports Next.js development through `@patchlens-ai/compiler-next` and `withPatchLensNext()`.

The package uses a loader compatible with both current Turbopack `rules` and the webpack fallback. It reuses the Babel-based JSX transform from `@patchlens-ai/compiler-vite`, changes manifest entries to framework `next`, and records render boundary metadata.

## Server and client boundaries

- Files with `'use client'` are marked `client`.
- Files with `'use server'` are marked `server`.
- App Router JSX files without a directive are marked `server`, matching the default Server Component model.
- Pages Router JSX files without a directive are marked `shared` because they execute across server rendering and client hydration.

Server Components cannot register an in-browser manifest through module side effects. The loader therefore emits a bounded, base64url-encoded source entry in `data-patchlens-source` beside each `data-patchlens-id`. Inspector validates and registers this metadata only when an element is selected, then strips it from sanitized DOM context.

## Development runtime

Next.js `instrumentation-client.ts` loads `@patchlens-ai/dev/runtime` only in development:

```ts
if (process.env.NODE_ENV === 'development') {
  void import('@patchlens-ai/dev/runtime').then(({ installPatchLensInspector }) => {
    void installPatchLensInspector({ manifestEndpoint: false });
  });
}
```

See `examples/next-app-demo` for Server Component and Client Component fixtures.

## Production boundary

The loader returns source unchanged in production. Runtime import stays behind the compile-time development branch. `scripts/check-production-leak.mjs` rejects PatchLens DOM attributes, runtime imports, and connection parameters in production output.

## Limitations

- Boundary detection is source-based. Re-export graphs may obscure the effective client boundary.
- Inline source metadata increases development HTML size.
- Custom Next compiler pipelines that bypass Turbopack and webpack loaders are unsupported.
- Route handlers and generated `.next` files are never instrumented.
- Next.js development with Rust-native transforms outside loader compatibility needs a future dedicated transform.
