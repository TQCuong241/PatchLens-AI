import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type {
  AgentChatResponse,
  AgentRequest,
  AgentSession,
  DaemonHealth,
} from "@patchlens-ai/agent-protocol";

const DEFAULT_PORT = 4311;
const MAX_BODY_BYTES = 1024 * 1024;
const port = parsePort(process.env.PATCHLENS_DAEMON_PORT);
const sessions = new Map<string, AgentSession>();

const server = createServer(async (request, response) => {
  setCommonHeaders(response);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      const health: DaemonHealth = {
        ok: true,
        service: "patchlens-daemon",
        version: "0.0.0",
        providers: [
          { id: "mock", status: "available" },
          { id: "codex", status: "planned" },
          { id: "claude", status: "planned" },
        ],
      };
      sendJson(response, 200, health);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const input = await readJsonBody<AgentRequest>(request);
      validateAgentRequest(input);

      const session = getOrCreateSession(input);
      session.status = "running";
      session.activeSelectionId = input.selection.id;

      await delay(420);

      session.status = "idle";
      const source = input.selection.primaryElement.source;
      const sourceSummary = source
        ? `${source.componentName ?? source.tagName ?? "Component"} in ${source.file}:${source.line}`
        : `${input.selection.primaryElement.tagName} (visual-only selection)`;
      const viewport = input.selection.viewport;
      const viewportSummary = viewport.preset
        ? `${viewport.preset} ${viewport.orientation ?? "viewport"} at ${viewport.width} × ${viewport.height}`
        : `${viewport.width} × ${viewport.height} viewport`;
      const plannedFiles = source ? [source.file] : [];
      const result: AgentChatResponse = {
        session: { ...session },
        reply: source
          ? `Selection locked to ${sourceSummary} for the ${viewportSummary}. The mock agent received your request and would keep edits focused on this component and responsive state.`
          : `The selected region has no exact source metadata yet. The agent would use its DOM, visual context, and ${viewportSummary} to locate the closest component.`,
        sourceSummary,
        plannedFiles,
      };

      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, {
      error: "not_found",
      message: `No PatchLens endpoint matches ${request.method ?? "UNKNOWN"} ${url.pathname}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown daemon error";
    sendJson(response, 400, {
      error: "bad_request",
      message,
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[PatchLens] Daemon listening on http://127.0.0.1:${port}`);
});

function getOrCreateSession(input: AgentRequest): AgentSession {
  if (input.sessionId) {
    const existing = sessions.get(input.sessionId);
    if (existing) {
      return existing;
    }
  }

  const session: AgentSession = {
    id: `session_${randomUUID()}`,
    projectId: "react-vite-demo",
    provider: input.provider,
    status: "idle",
    activeSelectionId: input.selection.id,
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.id, session);
  return session;
}

function validateAgentRequest(value: AgentRequest): void {
  if (!value || typeof value !== "object") {
    throw new Error("Request body must be a JSON object.");
  }

  if (typeof value.instruction !== "string" || value.instruction.trim().length === 0) {
    throw new Error("Instruction is required.");
  }

  if (!value.selection?.id || !value.selection.primaryElement) {
    throw new Error("A valid PatchLens selection is required.");
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds the 1 MB limit.");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    throw new Error("Request body is empty.");
  }

  return JSON.parse(text) as T;
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : DEFAULT_PORT;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
