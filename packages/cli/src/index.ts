import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  request as createProxyRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDaemonUrl,
  startPatchLensMcpServer,
} from "@patchlens-ai/mcp-server";

export type CliIO = {
  log(message: string): void;
  error(message: string): void;
};

type ProjectPackage = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PatchLensProjectConfig = {
  preview?: {
    command?: string;
    url?: string;
  };
};

type RunningService = {
  name: string;
  process: ChildProcess;
};

const DEFAULT_DAEMON_URL = "http://127.0.0.1:4311";
const DEFAULT_STUDIO_PORT = 4310;

export async function runCli(
  arguments_: string[] = process.argv.slice(2),
  io: CliIO = console,
): Promise<number> {
  const [command = "help"] = arguments_;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp(io);
    return 0;
  }

  if (command === "init") {
    return initializeProject(process.cwd(), io);
  }

  if (command === "doctor") {
    return runDoctor(process.cwd(), io);
  }

  if (command === "start") {
    return startPatchLens(process.cwd(), arguments_.slice(1), io);
  }

  if (command === "mcp") {
    const connection = await readDaemonConnection(process.cwd());
    const configuredAuthToken = process.env.PATCHLENS_AUTH_TOKEN;
    const authToken = configuredAuthToken ?? connection?.token;
    if (!authToken) {
      io.error(
        "PatchLens could not find the running daemon token. Start the daemon and run this command from the project root.",
      );
      return 1;
    }
    try {
      await startPatchLensMcpServer({
        daemonUrl: process.env.PATCHLENS_DAEMON_URL ??
          (configuredAuthToken ? undefined : connection?.daemonUrl),
        authToken,
      });
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : "PatchLens MCP could not start.");
      return 1;
    }
  }

  io.error(`Unknown PatchLens command: ${command}`);
  printHelp(io);
  return 1;
}

async function initializeProject(projectRoot: string, io: CliIO): Promise<number> {
  const packagePath = path.join(projectRoot, "package.json");
  const projectPackage = await readProjectPackage(packagePath);
  if (!projectPackage) {
    io.error("PatchLens could not find package.json in the current directory.");
    return 1;
  }

  const configDirectory = path.join(projectRoot, ".patchlens");
  const configPath = path.join(configDirectory, "config.json");
  if (await exists(configPath)) {
    await ensureStateIsIgnored(projectRoot);
    io.log("PatchLens is already initialized in this project.");
    return 0;
  }

  const framework = detectFramework(projectPackage);
  const config = {
    version: 1,
    framework,
    projectRoot: ".",
    preview: {
      command: inferDevCommand(projectPackage),
      url: "http://127.0.0.1:5173",
      viewports: ["desktop", "tablet", "mobile"],
    },
    agent: {
      defaultProvider: "mock",
      scopePolicy: "prefer-selection",
      providers: {
        mock: { enabled: true },
        codex: { enabled: true, command: "codex" },
        claude: { enabled: true, command: "claude" },
      },
    },
    safety: {
      transactionHistory: ".patchlens/transactions.json",
      requireScopeApproval: true,
      refuseUndoAfterDeveloperEdits: true,
    },
  };

  await mkdir(configDirectory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await ensureStateIsIgnored(projectRoot);

  io.log(`PatchLens initialized for ${framework}.`);
  io.log("Created .patchlens/config.json");
  io.log("Protected local transaction state in .gitignore");
  io.log("Next: add `patchLens()` from `@patchlens-ai/dev` to the Vite plugins, then run `patchlens start`.");
  return 0;
}

async function startPatchLens(
  projectRoot: string,
  arguments_: string[],
  io: CliIO,
): Promise<number> {
  const configPath = path.join(projectRoot, ".patchlens", "config.json");
  const config = await readProjectConfig(configPath);
  if (!config) {
    io.error("PatchLens is not initialized here. Run `patchlens init` first.");
    return 1;
  }

  const studioPort = parseCliPort(
    readArgument(arguments_, "--studio-port") ?? process.env.PATCHLENS_STUDIO_PORT,
    DEFAULT_STUDIO_PORT,
  );
  const daemonPort = parseCliPort(
    readArgument(arguments_, "--daemon-port") ?? process.env.PATCHLENS_DAEMON_PORT,
    4311,
  );
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  let previewUrl: string;
  try {
    previewUrl = parsePreviewUrl(
      readArgument(arguments_, "--preview-url") ?? config.preview?.url,
    );
  } catch (error) {
    io.error(error instanceof Error ? error.message : "Preview URL is invalid.");
    return 1;
  }
  const previewCommand = readArgument(arguments_, "--preview-command")
    ?? config.preview?.command;
  const noPreview = arguments_.includes("--no-preview");
  const services: RunningService[] = [];
  let studioServer: Server | undefined;
  let stopping = false;

  try {
    const studioPackageFile = fileURLToPath(
      await import.meta.resolve("@patchlens-ai/studio/package.json"),
    );
    const studioDist = path.join(path.dirname(studioPackageFile), "dist");
    if (!(await exists(path.join(studioDist, "index.html")))) {
      io.error("PatchLens Studio is not built. Run `pnpm build` before `patchlens start`.");
      return 1;
    }

    if (!noPreview && previewCommand) {
      const previewProcess = spawn(previewCommand, {
        cwd: projectRoot,
        env: process.env,
        shell: true,
        windowsHide: true,
        stdio: "inherit",
      });
      services.push({ name: "preview", process: previewProcess });
    } else if (!noPreview) {
      io.log("No preview command is configured; using an already-running preview.");
    }

    const daemonEntry = fileURLToPath(
      await import.meta.resolve("@patchlens-ai/daemon"),
    );
    const daemonProcess = spawn(process.execPath, [daemonEntry], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PATCHLENS_PROJECT_ROOT: projectRoot,
        PATCHLENS_PREVIEW_URL: previewUrl,
        PATCHLENS_DAEMON_PORT: String(daemonPort),
        PATCHLENS_STUDIO_ORIGINS: [
          `http://127.0.0.1:${studioPort}`,
          `http://localhost:${studioPort}`,
        ].join(","),
      },
      windowsHide: true,
      stdio: "inherit",
    });
    services.push({ name: "daemon", process: daemonProcess });

    await waitForDaemon(daemonUrl);
    studioServer = createStudioServer(studioDist, daemonUrl);
    await listenServer(studioServer, studioPort);

    io.log("");
    io.log(`PatchLens Studio: http://127.0.0.1:${studioPort}`);
    io.log(`Preview: ${previewUrl}`);
    io.log("Press Ctrl+C to stop PatchLens and the preview process.");

    return await waitForWorkspaceExit({
      services,
      io,
      stop: async () => {
        if (stopping) {
          return;
        }
        stopping = true;
        await closeServer(studioServer);
        await Promise.all(services.map((service) => terminateService(service)));
      },
    });
  } catch (error) {
    stopping = true;
    await closeServer(studioServer);
    await Promise.all(services.map((service) => terminateService(service)));
    io.error(error instanceof Error ? error.message : "PatchLens could not start.");
    return 1;
  }
}

async function readProjectConfig(file: string): Promise<PatchLensProjectConfig | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as PatchLensProjectConfig;
  } catch {
    return undefined;
  }
}

function readArgument(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function parseCliPort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parsePreviewUrl(value: string | undefined): string {
  const candidate = value ?? "http://127.0.0.1:5173";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Preview URL must use HTTP or HTTPS.");
    }
    if (url.username || url.password) {
      throw new Error("Preview URL must not contain embedded credentials.");
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "Preview URL is invalid.",
    );
  }
}

async function waitForDaemon(daemonUrl: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${daemonUrl}/api/health`, {
        signal: AbortSignal.timeout(700),
      });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unavailable";
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`PatchLens daemon did not start (${lastError || "timeout"}).`);
}

export function createStudioServer(studioDist: string, daemonUrl: string): Server {
  return createServer((request, response) => {
    const requestPath = readRequestPath(request.url);
    if (requestPath?.startsWith("/api/")) {
      proxyDaemonRequest(request, response, daemonUrl);
      return;
    }
    if (requestPath === undefined) {
      sendText(response, 400, "Invalid URL.");
      return;
    }
    void serveStudioFile(request, response, studioDist);
  });
}

function readRequestPath(requestUrl: string | undefined): string | undefined {
  try {
    const parsed = new URL(requestUrl ?? "/", "http://patchlens.local");
    // Reject absolute-form URLs so the proxy can never be redirected off-loopback.
    if (parsed.origin !== "http://patchlens.local") {
      return undefined;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

function proxyDaemonRequest(
  request: IncomingMessage,
  response: ServerResponse,
  daemonUrl: string,
): void {
  const requestPath = readRequestPath(request.url);
  if (!requestPath) {
    sendText(response, 400, "Invalid URL.");
    return;
  }
  const target = new URL(requestPath, daemonUrl);
  const headers = { ...request.headers, host: target.host };
  delete headers.connection;
  const proxy = createProxyRequest(
    target,
    {
      method: request.method,
      headers,
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    },
  );
  proxy.on("error", () => {
    if (!response.headersSent) {
      sendText(response, 502, "PatchLens daemon is unavailable.");
    } else {
      response.destroy();
    }
  });
  request.pipe(proxy);
}

async function serveStudioFile(
  request: IncomingMessage,
  response: ServerResponse,
  studioDist: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed.");
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://patchlens.local").pathname);
  } catch {
    sendText(response, 400, "Invalid URL.");
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(studioDist, relative);
  const relativeCandidate = path.relative(studioDist, candidate);
  if (
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCandidate)
  ) {
    sendText(response, 403, "Path rejected.");
    return;
  }

  let file = candidate;
  if (!(await exists(file)) && !path.extname(relative)) {
    file = path.join(studioDist, "index.html");
  }
  try {
    const rootRealPath = await realpath(studioDist);
    const fileRealPath = await realpath(file);
    const realRelative = path.relative(rootRealPath, fileRealPath);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      sendText(response, 403, "Path rejected.");
      return;
    }
    const content = await readFile(file);
    const contentType = contentTypeFor(file);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", path.basename(file) === "index.html"
      ? "no-store"
      : "public, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Length", content.byteLength);
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(content);
    }
  } catch {
    sendText(response, 404, "PatchLens Studio file not found.");
  }
}

function contentTypeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendText(response: ServerResponse, statusCode: number, message: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(message);
}

function listenServer(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForWorkspaceExit(input: {
  services: RunningService[];
  io: CliIO;
  stop(): Promise<void>;
}): Promise<number> {
  return new Promise((resolve) => {
    let finished = false;
    const exitHandlers = new Map<ChildProcess, (code: number | null, signal: NodeJS.Signals | null) => void>();
    const finish = async (code: number, message?: string): Promise<void> => {
      if (finished) {
        return;
      }
      finished = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      for (const [child, handler] of exitHandlers) {
        child.removeListener("exit", handler);
      }
      if (message) {
        input.io.error(message);
      }
      await input.stop();
      resolve(code);
    };
    const onSignal = (): void => {
      void finish(0);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    for (const service of input.services) {
      const handler = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (!finished) {
          void finish(
            1,
            `${service.name} stopped unexpectedly (${signal ?? `exit ${code ?? 1}`}).`,
          );
        }
      };
      exitHandlers.set(service.process, handler);
      service.process.on("exit", handler);
      if (service.process.exitCode !== null) {
        handler(service.process.exitCode, null);
      }
    }
  });
}

async function terminateService(service: RunningService): Promise<void> {
  const child = service.process;
  if (child.exitCode !== null || child.killed) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      child.removeListener("exit", finishOnExit);
      clearTimeout(timeout);
      resolve();
    };
    const finishOnExit = (): void => finish();
    const timeout = setTimeout(finish, 2_000);
    child.once("exit", finishOnExit);
    child.kill("SIGTERM");
  });
}

async function runDoctor(projectRoot: string, io: CliIO): Promise<number> {
  const packagePath = path.join(projectRoot, "package.json");
  const projectPackage = await readProjectPackage(packagePath);
  const configPath = path.join(projectRoot, ".patchlens", "config.json");

  io.log("PatchLens doctor");
  io.log(`  Node.js: ${process.version}`);
  io.log(`  Project: ${projectPackage ? "found" : "missing package.json"}`);
  io.log(`  Framework: ${projectPackage ? detectFramework(projectPackage) : "unknown"}`);
  io.log(`  Config: ${(await exists(configPath)) ? "found" : "not initialized"}`);
  io.log(`  Codex CLI: ${(await commandIsAvailable("codex")) ? "available" : "not detected"}`);
  io.log(`  Claude CLI: ${(await commandIsAvailable("claude")) ? "available" : "not detected"}`);
  io.log("  MCP bridge: available through `patchlens mcp`");

  try {
    const connection = await readDaemonConnection(projectRoot);
    const configuredAuthToken = process.env.PATCHLENS_AUTH_TOKEN;
    const daemonUrl = resolveDaemonUrl(
      process.env.PATCHLENS_DAEMON_URL ??
        (configuredAuthToken ? undefined : connection?.daemonUrl) ??
        DEFAULT_DAEMON_URL,
    );
    const authToken = configuredAuthToken ?? connection?.token;
    const response = await fetch(`${daemonUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(700),
    });
    if (response.ok) {
      const health = await response.json() as {
        ok?: unknown;
        service?: unknown;
        providers?: Array<{ id: string; status: string; detail?: string }>;
      };
      if (health.ok !== true || health.service !== "patchlens-daemon") {
        io.log("  Daemon: unexpected service response");
        return projectPackage ? 0 : 1;
      }
      io.log("  Daemon: online");
      for (const provider of health.providers ?? []) {
        io.log(
          `    ${provider.id}: ${provider.status}${provider.detail ? ` (${provider.detail})` : ""}`,
        );
      }
      const protectedResponse = await fetch(
        `${daemonUrl.replace(/\/$/, "")}/api/transactions`,
        {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          signal: AbortSignal.timeout(700),
        },
      );
      io.log(
        `  Local authentication: ${protectedResponse.ok
          ? "ready"
          : authToken
            ? `rejected (HTTP ${protectedResponse.status})`
            : "connection token not found"}`,
      );
    } else {
      io.log(`  Daemon: HTTP ${response.status}`);
    }
  } catch {
    io.log("  Daemon: offline");
  }

  return projectPackage ? 0 : 1;
}

async function readProjectPackage(file: string): Promise<ProjectPackage | undefined> {
  try {
    const content = await readFile(file, "utf8");
    return JSON.parse(content) as ProjectPackage;
  } catch {
    return undefined;
  }
}

function detectFramework(projectPackage: ProjectPackage): string {
  const dependencies = {
    ...projectPackage.dependencies,
    ...projectPackage.devDependencies,
  };

  if (dependencies.next) {
    return "next";
  }

  if (dependencies.vite && dependencies.react) {
    return "react-vite";
  }

  if (dependencies.vite) {
    return "vite";
  }

  return "unknown";
}

function inferDevCommand(projectPackage: ProjectPackage): string | undefined {
  if (projectPackage.scripts?.dev) {
    return "npm run dev";
  }
  if (projectPackage.scripts?.start) {
    return "npm start";
  }
  return undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureStateIsIgnored(projectRoot: string): Promise<void> {
  const ignorePath = path.join(projectRoot, ".gitignore");
  const entries = [
    ".patchlens/transactions.json",
    ".patchlens/daemon.json",
    ".patchlens/.transactions-*.tmp",
    ".patchlens/.daemon-*.tmp",
    "**/.patchlens-*.tmp",
  ];
  let current = "";
  try {
    current = await readFile(ignorePath, "utf8");
  } catch {
    // A new project may not have a .gitignore yet.
  }
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !existing.has(entry));
  if (missing.length === 0) {
    return;
  }
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(
    ignorePath,
    `${current}${separator}${missing.join("\n")}\n`,
    "utf8",
  );
}

async function readDaemonConnection(projectRoot: string): Promise<{
  daemonUrl?: string;
  token?: string;
} | undefined> {
  try {
    const file = path.join(projectRoot, ".patchlens", "daemon.json");
    if ((await stat(file)).size > 64 * 1_024) {
      return undefined;
    }
    const value = JSON.parse(
      await readFile(file, "utf8"),
    ) as { daemonUrl?: unknown; token?: unknown };
    return {
      daemonUrl: typeof value.daemonUrl === "string" && value.daemonUrl.length <= 2_000
        ? value.daemonUrl
        : undefined,
      token: typeof value.token === "string" &&
          value.token.length >= 24 &&
          value.token.length <= 500
        ? value.token
        : undefined,
    };
  } catch {
    return undefined;
  }
}

async function commandIsAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (available: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(available);
    };
    timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2500);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function printHelp(io: CliIO): void {
  io.log("PatchLens AI");
  io.log("");
  io.log("Usage: patchlens <command>");
  io.log("");
  io.log("Commands:");
  io.log("  init     Create a local PatchLens project configuration");
  io.log("  start    Start the daemon, Studio, and configured preview");
  io.log("  doctor   Check the project, framework and local daemon");
  io.log("  mcp      Start the read-only MCP bridge for Codex or Claude");
  io.log("  help     Show this help message");
  io.log("");
  io.log("Start options: --no-preview, --studio-port <port>, --daemon-port <port>,");
  io.log("              --preview-url <url>, --preview-command <command>");
}
