/// <reference types='vite/client' />

interface ImportMetaEnv {
  readonly VITE_PATCHLENS_DAEMON_URL?: string;
  readonly VITE_PATCHLENS_DAEMON_TOKEN?: string;
  readonly VITE_PATCHLENS_PROJECT_ROOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
