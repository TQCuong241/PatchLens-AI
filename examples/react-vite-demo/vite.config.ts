import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { patchLensVitePlugin } from '@patchlens-ai/dev/vite';

export default defineConfig({
  plugins: [patchLensVitePlugin(), react()],
});
