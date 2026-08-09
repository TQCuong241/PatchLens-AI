import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createStudioServer, runCli, type CliIO } from "./index.js";

function captureIo(): { io: CliIO; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
    logs,
    errors,
  };
}

test("help lists the complete local launcher surface", async () => {
  const captured = captureIo();
  const exitCode = await runCli(["help"], captured.io);

  assert.equal(exitCode, 0);
  assert.match(captured.logs.join("\n"), /init/);
  assert.match(captured.logs.join("\n"), /start/);
  assert.match(captured.logs.join("\n"), /mcp/);
});

test("init creates a minimal safe project configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patchlens-cli-"));
  const previousDirectory = process.cwd();
  const captured = captureIo();

  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { vite: "latest" } }),
      "utf8",
    );
    process.chdir(root);

    assert.equal(await runCli(["init"], captured.io), 0);
    const config = JSON.parse(
      await readFile(path.join(root, ".patchlens", "config.json"), "utf8"),
    ) as { framework: string; preview?: { command?: string } };
    const ignore = await readFile(path.join(root, ".gitignore"), "utf8");

    assert.equal(config.framework, "vite");
    assert.equal(config.preview?.command, undefined);
    assert.match(ignore, /\.patchlens\/daemon\.json/);
    assert.match(ignore, /\.patchlens\/transactions\.json/);
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown commands return a helpful failure", async () => {
  const captured = captureIo();
  const exitCode = await runCli(["not-a-command"], captured.io);

  assert.equal(exitCode, 1);
  assert.match(captured.errors.join("\n"), /Unknown PatchLens command/);
});

test("start rejects preview URLs with embedded credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patchlens-cli-start-"));
  const previousDirectory = process.cwd();
  const captured = captureIo();

  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", scripts: { dev: "node dev.js" } }),
      "utf8",
    );
    process.chdir(root);
    assert.equal(await runCli(["init"], captured.io), 0);

    const start = captureIo();
    assert.equal(
      await runCli(["start", "--preview-url", "http://user:pass@127.0.0.1:5173"], start.io),
      1,
    );
    assert.match(start.errors.join("\n"), /embedded credentials/);
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("the production Studio shell serves SPA fallbacks without allowing traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patchlens-studio-server-"));
  const dist = path.join(root, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<main>studio</main>", "utf8");
  await writeFile(path.join(dist, "asset.js"), "console.log('ok')", "utf8");
  const server = createStudioServer(dist, "http://127.0.0.1:9");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const rootResponse = await fetch(`${base}/missing/route`);
    assert.equal(rootResponse.status, 200);
    assert.equal(await rootResponse.text(), "<main>studio</main>");
    const assetResponse = await fetch(`${base}/asset.js`);
    assert.equal(assetResponse.headers.get("content-type"), "text/javascript; charset=utf-8");
    const traversalResponse = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(traversalResponse.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("the Studio proxy rejects absolute-form API request targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "patchlens-studio-proxy-"));
  const server = createStudioServer(root, "http://127.0.0.1:9");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");

    const result = await new Promise<{ body: string; statusCode: number | undefined }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            path: "http://attacker.invalid/api/health",
            port: address.port,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                body: Buffer.concat(chunks).toString("utf8"),
                statusCode: response.statusCode,
              }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      },
    );

    assert.equal(result.statusCode, 400);
    assert.equal(result.body, "Invalid URL.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
