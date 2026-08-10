import { createDaemonServer } from './server.js';

const port = parsePort(process.env.PATCHLENS_PORT);
const studioOrigin = process.env.PATCHLENS_STUDIO_ORIGIN ?? 'http://127.0.0.1:4310';
const daemon = createDaemonServer({
  port,
  allowedOrigins: [studioOrigin],
  token: process.env.PATCHLENS_SESSION_TOKEN,
});

const address = await daemon.start();
console.log(`PatchLens daemon listening on http://${address.address}:${address.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await daemon.stop();
    process.exitCode = 0;
  });
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return 4312;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PATCHLENS_PORT: ${value}`);
  }
  return port;
}
