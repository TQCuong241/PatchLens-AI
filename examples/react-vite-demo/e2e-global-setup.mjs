import { URL, fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default async function setup() {
  const server = await createServer({
    root,
    server: {
      host: '127.0.0.1',
      port: 4311,
      strictPort: true,
    },
  });

  await server.listen();

  return async () => {
    await server.close();
  };
}
