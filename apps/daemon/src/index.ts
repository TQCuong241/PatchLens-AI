import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ActiveSelectionSnapshot,
  AgentChatResponse,
  AgentRequest,
  AgentSession,
  DaemonHealth,
  PatchTransaction,
  PatchVerification,
  UndoPatchTransactionResponse,
} from "@patchlens-ai/agent-protocol";
import {
  isSelectionContext,
  isVisualSelection,
} from "@patchlens-ai/agent-protocol";
import {
  CodingProviderError,
  createDefaultProviderRegistry,
} from "@patchlens-ai/coding-provider";
import {
  PatchTransactionConflictError,
  PatchTransactionError,
  PatchTransactionManager,
} from "@patchlens-ai/patch-transaction";

const DEFAULT_PORT = 4311;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SELECTION_CONTEXT_BYTES = 320 * 1024;
const MAX_INSTRUCTION_CHARACTERS = 20_000;
const SESSION_COOKIE_NAME = "patchlens_session";
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_PROJECT_ROOT = path.join(WORKSPACE_ROOT, "examples", "react-vite-demo");
const projectRoot = path.resolve(
  process.env.PATCHLENS_PROJECT_ROOT ?? DEFAULT_PROJECT_ROOT,
);
const projectId = process.env.PATCHLENS_PROJECT_ID ?? path.basename(projectRoot);
const previewUrl = process.env.PATCHLENS_PREVIEW_URL ?? "http://127.0.0.1:4312";
const port = parsePort(process.env.PATCHLENS_DAEMON_PORT);
const daemonToken = createDaemonToken(process.env.PATCHLENS_AUTH_TOKEN);
const daemonConnectionFile = path.join(projectRoot, ".patchlens", "daemon.json");
let ownedDaemonConnectionFile: string | undefined;
const sessions = new Map<string, AgentSession>();
let activeSelection: ActiveSelectionSnapshot | undefined;
const activeRequests = new Map<string, AbortController>();
const providerRegistry = createDefaultProviderRegistry();
const providerStates = new Map<string, { status: "available" | "planned" | "unavailable"; detail?: string }>([
  ["mock", { status: "available", detail: "Built into the local daemon." }],
  ["codex", { status: "planned", detail: "Checking local Codex CLI." }],
  ["claude", { status: "planned", detail: "Checking local Claude CLI." }],
]);
const transactionManager = new PatchTransactionManager({ projectRoot });

const server = createServer(async (request, response) => {
  if (!setCommonHeaders(request, response)) {
    return;
  }

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (request.method === "POST" && url.pathname === "/api/auth/session") {
      if (!request.headers.origin) {
        sendJson(response, 400, {
          error: "browser_origin_required",
          message: "PatchLens Studio authentication requires an allowed browser origin.",
        });
        return;
      }
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(daemonToken)}; Max-Age=3600; HttpOnly; SameSite=Strict; Path=/api`,
      );
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, createHealth());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/project") {
      sendJson(response, 200, {
        projectId,
        previewUrl,
        transactionHistory: true,
      });
      return;
    }

    if (!isAuthorizedRequest(request)) {
      sendJson(response, 401, {
        error: "authentication_required",
        message: "Authenticate PatchLens Studio or provide the local daemon bearer token.",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/selection") {
      if (!activeSelection) {
        sendJson(response, 404, {
          error: "selection_not_found",
          message: "No component is currently selected in PatchLens Studio.",
        });
        return;
      }
      sendJson(response, 200, activeSelection);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/selection") {
      const input = await readJsonBody<{
        selection: ActiveSelectionSnapshot["selection"];
        context?: ActiveSelectionSnapshot["context"];
      }>(request);
      if (!input.selection?.id || !input.selection.primaryElement) {
        throw new Error("A valid active selection is required.");
      }
      if (input.context && input.context.selection.id !== input.selection.id) {
        throw new Error("Active selection context does not match the selection.");
      }
      validateSelectionPayload(input.selection, input.context);
      activeSelection = {
        selection: input.selection,
        context: input.context,
        updatedAt: new Date().toISOString(),
      };
      sendJson(response, 200, { ok: true, selectionId: input.selection.id });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/selection/clear") {
      activeSelection = undefined;
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const input = await readJsonBody<AgentRequest>(request);
      validateAgentRequest(input);
      const result = await handleChat(input);
      sendJson(response, 200, result);
      return;
    }

    const sessionCancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && sessionCancelMatch) {
      const controller = activeRequests.get(sessionCancelMatch[1]!);
      if (!controller) {
        sendJson(response, 404, {
          error: "session_not_running",
          message: "That PatchLens session has no running provider request.",
        });
        return;
      }
      controller.abort();
      sendJson(response, 202, { ok: true, sessionId: sessionCancelMatch[1] });
      return;
    }

    const transactionListMatch = url.pathname === "/api/transactions";
    if (request.method === "GET" && transactionListMatch) {
      sendJson(response, 200, {
        transactions: transactionManager.list(url.searchParams.get("sessionId") ?? undefined),
      });
      return;
    }

    const transactionMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
    if (request.method === "GET" && transactionMatch) {
      const transaction = transactionManager.get(transactionMatch[1]!);
      if (!transaction) {
        throw new PatchTransactionError(
          "transaction_not_found",
          `Patch transaction ${transactionMatch[1]} does not exist.`,
        );
      }
      sendJson(response, 200, transaction);
      return;
    }

    const undoMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)\/undo$/);
    if (request.method === "POST" && undoMatch) {
      const transaction = await transactionManager.undo(undoMatch[1]!);
      const result: UndoPatchTransactionResponse = {
        transaction,
        message: `Reverted ${transaction.files.length} agent-owned file change without resetting the repository.`,
      };
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, {
      error: "not_found",
      message: `No PatchLens endpoint matches ${request.method ?? "UNKNOWN"} ${url.pathname}.`,
    });
  } catch (error) {
    handleError(response, error);
  }
});

async function handleChat(input: AgentRequest): Promise<AgentChatResponse> {
  const session = getOrCreateSession(input);
  if (activeRequests.has(session.id)) {
    throw new CodingProviderError(
      "session_busy",
      "This PatchLens session already has a running provider request.",
    );
  }
  session.status = "running";
  session.activeSelectionId = input.selection.id;

  const controller = new AbortController();
  activeRequests.set(session.id, controller);

  try {
    const provider = providerRegistry.get(input.provider);
    const providerResult = await provider.run({
      request: input,
      projectRoot,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new CodingProviderError(
        "provider_cancelled",
        "The coding provider request was cancelled before PatchLens could apply a patch.",
      );
    }
    session.providerSessionId = providerResult.providerSessionId ?? session.providerSessionId;

    let transaction: PatchTransaction | undefined;
    let reply = providerResult.reply;
    let scopeExpansionRequired: string[] | undefined;

    if (providerResult.replacements.length > 0) {
      try {
        transaction = await transactionManager.applyTextReplacements({
          sessionId: session.id,
          selectionId: input.selection.id,
          instruction: input.instruction,
          changes: providerResult.replacements,
          selectedFiles: input.selection.primaryElement.source
            ? [input.selection.primaryElement.source.file]
            : [],
          scopePolicy: input.scopePolicy,
          approvedScopeExpansion: input.approvedScopeExpansion,
        });
        try {
          transaction = await transactionManager.setVerification(
            transaction.id,
            await verifyPreview(input, transaction.updatedAt),
          );
        } catch {
          reply = `${reply} The patch was applied, but the verification record could not be saved.`;
        }
        reply = `${reply} Applied transaction ${transaction.id}. Review the diff before undoing it; PatchLens will not overwrite newer developer edits.`;
      } catch (error) {
        if (error instanceof PatchTransactionError && error.code === "scope_approval_required") {
          scopeExpansionRequired = providerResult.plannedFiles.filter(
            (file) => !samePath(file, input.selection.primaryElement.source?.file),
          );
          reply = `No files changed. ${error.message} Set scope to allow related files only when you want the agent to continue.`;
        } else if (error instanceof PatchTransactionError) {
          reply = `No files changed. ${error.message}`;
          transaction = error.transaction;
        } else {
          throw error;
        }
      }
    }

    session.status = "idle";
    return {
      session: { ...session },
      reply,
      sourceSummary: describeSelection(input),
      plannedFiles: providerResult.plannedFiles,
      transaction,
      scopeExpansionRequired,
    };
  } catch (error) {
    session.status = error instanceof CodingProviderError && error.code === "provider_cancelled"
      ? "waiting"
      : "failed";
    throw error;
  } finally {
    activeRequests.delete(session.id);
    if (session.status === "running") {
      session.status = "idle";
    }
  }
}

function createHealth(): DaemonHealth {
  return {
    ok: true,
    service: "patchlens-daemon",
    version: "0.0.0",
    authentication: {
      browserSession: true,
      bearerToken: true,
    },
    providers: Array.from(providerStates.entries()).map(([id, state]) => ({
      id,
      status: state.status,
      detail: state.detail,
    })),
  };
}

function getOrCreateSession(input: AgentRequest): AgentSession {
  if (input.sessionId) {
    const existing = sessions.get(input.sessionId);
    if (existing) {
      if (existing.provider !== input.provider) {
        throw new Error("A PatchLens session cannot switch providers mid-conversation.");
      }
      return existing;
    }
  }

  const session: AgentSession = {
    id: input.sessionId ?? `session_${randomUUID()}`,
    projectId,
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
  if (typeof value.provider !== "string" || !value.provider.trim()) {
    throw new Error("A coding provider is required.");
  }
  if (value.provider.length > 64) {
    throw new Error("The coding provider id is too long.");
  }
  if (value.sessionId && !/^session_[A-Za-z0-9_-]{8,160}$/.test(value.sessionId)) {
    throw new Error("The PatchLens session id is invalid.");
  }
  if (
    typeof value.instruction !== "string" ||
    value.instruction.trim().length === 0 ||
    value.instruction.length > MAX_INSTRUCTION_CHARACTERS
  ) {
    throw new Error("Instruction is required.");
  }
  if (!value.selection?.id || !value.selection.primaryElement) {
    throw new Error("A valid PatchLens selection is required.");
  }
  if (!["prefer-selection", "strict", "allow-related"].includes(value.scopePolicy)) {
    throw new Error("An explicit PatchLens scope policy is required.");
  }
  if (value.context && value.context.selection.id !== value.selection.id) {
    throw new Error("Selection context does not match the selected element.");
  }
  validateSelectionPayload(value.selection, value.context);
  if (value.conversation !== undefined && (
    !Array.isArray(value.conversation) ||
    value.conversation.length > 40 ||
    value.conversation.some((message) =>
      !message ||
      typeof message !== "object" ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length > 8000
    )
  )) {
    throw new Error("The PatchLens conversation context exceeds its safe limits.");
  }
  if (value.approvedScopeExpansion !== undefined && (
    !Array.isArray(value.approvedScopeExpansion) ||
    value.approvedScopeExpansion.length > 64 ||
    value.approvedScopeExpansion.some((file) =>
        typeof file !== "string" ||
        !file ||
        file.length > 1000 ||
        file.includes("\0") ||
        path.isAbsolute(file) ||
        file.startsWith("../") ||
        file.startsWith("..\\")
      )
  )) {
    throw new Error("The approved PatchLens scope expansion is invalid.");
  }
}

function validateSelectionPayload(
  selection: AgentRequest["selection"],
  context?: AgentRequest["context"],
): void {
  if (!isVisualSelection(selection)) {
    throw new Error("The PatchLens visual selection exceeds its safe limits.");
  }
  if (
    typeof selection.id !== "string" ||
    selection.id.length > 240 ||
    !["element", "region"].includes(selection.kind) ||
    typeof selection.route !== "string" ||
    selection.route.length > 2000 ||
    typeof selection.createdAt !== "string" ||
    selection.createdAt.length > 100 ||
    !["exact", "likely", "visual-only"].includes(selection.confidence) ||
    !Array.isArray(selection.elements) ||
    selection.elements.length > 16 ||
    !isRectangle(selection.rectangle) ||
    !isViewport(selection.viewport)
  ) {
    throw new Error("The PatchLens visual selection exceeds its safe limits.");
  }
  const elements = [selection.primaryElement, ...selection.elements];
  if (elements.some((element) =>
    !element ||
    typeof element.tagName !== "string" ||
    element.tagName.length > 120 ||
    typeof element.text !== "string" ||
    element.text.length > 2000 ||
    typeof element.html !== "string" ||
    element.html.length > 8000 ||
    (
      element.directText !== undefined &&
      (typeof element.directText !== "string" || element.directText.length > 2000)
    ) ||
    !isRectangle(element.rectangle) ||
    !isSourceLocation(element.source)
  )) {
    throw new Error("A selected element exceeds the PatchLens context limits.");
  }
  if (!context) {
    return;
  }
  if (!isSelectionContext(context)) {
    throw new Error("The PatchLens selection context exceeds its safe limits.");
  }
  if (
    context.selection.id !== selection.id ||
    typeof context.sanitizedHtml !== "string" ||
    context.sanitizedHtml.length > 12_000 ||
    !context.computedStyles ||
    typeof context.computedStyles !== "object" ||
    Object.keys(context.computedStyles).length > 100 ||
    Object.entries(context.computedStyles).some(([name, style]) =>
      name.length > 120 || typeof style !== "string" || style.length > 500
    ) ||
    !Array.isArray(context.consoleErrors) ||
    context.consoleErrors.length > 20 ||
    context.consoleErrors.some((error) =>
      typeof error !== "string" || error.length > 1000
    ) ||
    typeof context.capturedAt !== "string" ||
    context.capturedAt.length > 100 ||
    typeof context.approximateBytes !== "number" ||
    !Number.isFinite(context.approximateBytes) ||
    context.approximateBytes < 0 ||
    !context.truncated ||
    typeof context.truncated.html !== "boolean" ||
    typeof context.truncated.styles !== "boolean" ||
    typeof context.truncated.consoleErrors !== "boolean" ||
    (context.accessibilitySummary !== undefined &&
      (typeof context.accessibilitySummary !== "string" ||
        context.accessibilitySummary.length > 2000)) ||
    Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_SELECTION_CONTEXT_BYTES
  ) {
    throw new Error("The PatchLens selection context exceeds its safe limits.");
  }
}

function isRectangle(value: AgentRequest["selection"]["rectangle"]): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  return [value?.x, value?.y, value?.width, value?.height].every((number) =>
    typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 100_000
  ) && value.width >= 0 && value.height >= 0;
}

function isViewport(value: AgentRequest["selection"]["viewport"]): boolean {
  return Boolean(
    value &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    Number.isFinite(value.deviceScaleFactor) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width <= 20_000 &&
    value.height <= 20_000 &&
    value.deviceScaleFactor > 0 &&
    value.deviceScaleFactor <= 10,
  );
}

function isSourceLocation(
  value: AgentRequest["selection"]["primaryElement"]["source"],
): boolean {
  if (!value) {
    return true;
  }
  return Boolean(
    typeof value.id === "string" &&
    value.id.length <= 240 &&
    typeof value.file === "string" &&
    value.file.length > 0 &&
    value.file.length <= 1000 &&
    !value.file.includes("\0") &&
    !path.isAbsolute(value.file) &&
    !value.file.startsWith("../") &&
    !value.file.startsWith("..\\") &&
    value.file !== "." &&
    Number.isInteger(value.line) &&
    value.line > 0 &&
    Number.isInteger(value.column) &&
    value.column > 0 &&
    (
      value.componentName === undefined ||
      (typeof value.componentName === "string" && value.componentName.length <= 240)
    ) &&
    (
      value.tagName === undefined ||
      (typeof value.tagName === "string" && value.tagName.length <= 120)
    ) &&
    (value.framework === "react" || value.framework === "next" || value.framework === "unknown"),
  );
}

function describeSelection(input: AgentRequest): string {
  const source = input.selection.primaryElement.source;
  const viewport = input.selection.viewport;
  const viewportSummary = `${viewport.preset ?? "custom"} ${viewport.width} x ${viewport.height}`;
  return source
    ? `${source.componentName ?? source.tagName ?? "Component"} in ${source.file}:${source.line} (${viewportSummary})`
    : `${input.selection.primaryElement.tagName} (visual-only selection, ${viewportSummary})`;
}

function samePath(left: string, right: string | undefined): boolean {
  if (!right) {
    return false;
  }
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function verifyPreview(
  input: AgentRequest,
  patchAppliedAt: string,
): Promise<PatchVerification> {
  const previewBase = new URL(
    previewUrl,
  );
  let previewTarget = new URL(input.selection.route || "/", previewBase);
  if (previewTarget.origin !== previewBase.origin) {
    previewTarget = previewBase;
  }

  await new Promise((resolve) => setTimeout(resolve, 220));
  let previewCheck: PatchVerification["checks"][number];
  try {
    const response = await fetch(previewTarget, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    previewCheck = {
      name: "preview-reachable",
      status: response.ok ? "passed" : "failed",
      detail: response.ok
        ? `Development preview returned HTTP ${response.status} after the patch.`
        : `Development preview returned HTTP ${response.status} after the patch.`,
    };
  } catch {
    previewCheck = {
      name: "preview-reachable",
      status: "failed",
      detail: "The development preview did not respond after the patch.",
    };
  }

  const refreshedSelection = await waitForPostPatchSelection(input, patchAppliedAt);
  const expectedPatchLensId = input.selection.primaryElement.patchlensId;
  const refreshedPatchLensId = refreshedSelection?.selection.primaryElement.patchlensId;
  const componentRetained = refreshedSelection
    ? expectedPatchLensId
      ? refreshedPatchLensId === expectedPatchLensId
      : refreshedSelection.selection.id === input.selection.id
    : undefined;
  const sourceRetained = refreshedSelection
    ? sameSourceLocation(
        input.selection.primaryElement.source,
        refreshedSelection.selection.primaryElement.source,
      )
    : undefined;
  const beforeErrors = new Set(input.context?.consoleErrors ?? []);
  const afterErrors = refreshedSelection?.context?.consoleErrors ?? [];
  const newErrors = afterErrors.filter((error) => !beforeErrors.has(error));

  const checks: PatchVerification["checks"] = [
    previewCheck,
    {
      name: "hmr-context-refresh",
      status: refreshedSelection ? "passed" : "skipped",
      detail: refreshedSelection
        ? "The Inspector published fresh context after the source transaction."
        : "PatchLens did not receive a fresh Inspector snapshot before the verification timeout.",
    },
    {
      name: "selected-component-present",
      status: componentRetained === undefined
        ? "skipped"
        : componentRetained
          ? "passed"
          : "failed",
      detail: componentRetained === undefined
        ? "The selected component could not be checked without a refreshed Inspector snapshot."
        : componentRetained
          ? "The same selected component remains mounted after the patch."
          : "The refreshed preview no longer resolves to the component selected before the patch.",
    },
    {
      name: "source-mapping",
      status: sourceRetained === undefined
        ? "skipped"
        : sourceRetained
          ? "passed"
          : "failed",
      detail: sourceRetained === undefined
        ? input.selection.primaryElement.source
          ? "Fresh browser context was unavailable, so source remapping could not be confirmed."
          : "The selection was visual-only before the patch."
        : sourceRetained
          ? "The selected component retained its source mapping after HMR."
          : "The selected component source mapping changed after the patch.",
    },
    {
      name: "post-patch-runtime-errors",
      status: refreshedSelection?.context
        ? newErrors.length === 0
          ? "passed"
          : "failed"
        : "skipped",
      detail: refreshedSelection?.context
        ? newErrors.length === 0
          ? "No new captured runtime errors appeared after the patch."
          : `${newErrors.length} new runtime error(s) appeared after the patch: ${newErrors.join(" | ")}`
        : "Fresh runtime error context was not available before the verification timeout.",
    },
  ];
  const hasFailedCheck = checks.some((check) => check.status === "failed");
  const hasSkippedCheck = checks.some((check) => check.status === "skipped");

  return {
    status: hasFailedCheck ? "failed" : hasSkippedCheck ? "partial" : "passed",
    route: input.selection.route,
    viewport: { ...input.selection.viewport },
    checks,
    checkedAt: new Date().toISOString(),
  };
}

async function waitForPostPatchSelection(
  input: AgentRequest,
  patchAppliedAt: string,
): Promise<ActiveSelectionSnapshot | undefined> {
  const beforeCapturedAt = input.context?.capturedAt ?? "";
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const snapshot = activeSelection;
    if (
      snapshot?.selection.id === input.selection.id &&
      snapshot.updatedAt > patchAppliedAt &&
      snapshot.context &&
      snapshot.context.capturedAt > beforeCapturedAt
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return undefined;
}

function sameSourceLocation(
  before: AgentRequest["selection"]["primaryElement"]["source"],
  after: AgentRequest["selection"]["primaryElement"]["source"],
): boolean | undefined {
  if (!before && !after) {
    return undefined;
  }
  if (!before || !after) {
    return false;
  }
  return samePath(before.file, after.file) && before.componentName === after.componentName;
}

function handleError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown daemon error";
  if (error instanceof PatchTransactionConflictError) {
    sendJson(response, 409, {
      error: error.code,
      message,
      transaction: error.transaction,
    });
    return;
  }
  if (error instanceof PatchTransactionError) {
    sendJson(response, error.code === "transaction_not_found" ? 404 : 400, {
      error: error.code,
      message,
      transaction: error.transaction,
    });
    return;
  }
  if (error instanceof CodingProviderError) {
    const status = error.code === "provider_unavailable"
      ? 503
      : error.code === "provider_timeout"
        ? 504
        : error.code === "provider_cancelled"
          ? 409
          : 400;
    sendJson(response, status, { error: error.code, message });
    return;
  }
  sendJson(response, 400, { error: "bad_request", message });
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

function setCommonHeaders(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  const allowedOrigins = new Set(
    (process.env.PATCHLENS_STUDIO_ORIGINS ??
      "http://127.0.0.1:4310,http://localhost:4310")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (origin && !allowedOrigins.has(origin)) {
    sendJson(response, 403, {
      error: "origin_rejected",
      message: "This browser origin is not allowed to control the local PatchLens daemon.",
    });
    return false;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  return true;
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

async function probeProviders(): Promise<void> {
  await Promise.all(providerRegistry.entries().map(async (provider) => {
    if (provider.id === "mock") {
      return;
    }
    const availability = await provider.probe();
    providerStates.set(provider.id, {
      status: availability.status,
      detail: availability.detail,
    });
  }));
}

async function start(): Promise<void> {
  await transactionManager.ready();
  await probeProviders();
  await new Promise<void>((resolve, reject) => {
    const handleListenError = (error: Error): void => reject(error);
    server.once("error", handleListenError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", handleListenError);
      resolve();
    });
  });
  try {
    await writeDaemonConnectionFile();
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  console.log(`[PatchLens] Daemon listening on http://127.0.0.1:${port}`);
}

void start().catch((error: unknown) => {
  console.error("[PatchLens] Daemon failed to start.", error);
  process.exitCode = 1;
});

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const controller of activeRequests.values()) {
    controller.abort();
  }
  const finish = (): void => {
    void removeOwnedDaemonConnectionFile().finally(() => process.exit(0));
  };
  if (server.listening) {
    server.close(finish);
  } else {
    finish();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function createDaemonToken(configuredToken: string | undefined): string {
  if (configuredToken && configuredToken.length >= 24 && configuredToken.length <= 500) {
    return configuredToken;
  }
  return `${randomUUID()}_${randomBytes(24).toString("base64url")}`;
}

function isAuthorizedRequest(request: IncomingMessage): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return tokensMatch(authorization.slice("Bearer ".length), daemonToken);
  }
  const cookies = parseCookies(request.headers.cookie);
  return tokensMatch(cookies.get(SESSION_COOKIE_NAME), daemonToken);
}

function tokensMatch(candidate: string | undefined, expected: string): boolean {
  if (!candidate) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const encodedValue = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(encodedValue));
    } catch {
      // Ignore malformed cookies instead of weakening authentication.
    }
  }
  return cookies;
}

async function writeDaemonConnectionFile(): Promise<void> {
  const directory = path.dirname(daemonConnectionFile);
  await mkdir(directory, { recursive: true });
  const [rootRealPath, directoryRealPath] = await Promise.all([
    realpath(projectRoot),
    realpath(directory),
  ]);
  const relativeDirectory = path.relative(rootRealPath, directoryRealPath);
  if (
    !relativeDirectory ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new Error("The PatchLens connection directory must stay inside the project root.");
  }
  const connectionFile = path.join(directoryRealPath, path.basename(daemonConnectionFile));
  const temporaryFile = path.join(
    directoryRealPath,
    `.daemon-${randomUUID()}.tmp`,
  );
  const body = `${JSON.stringify({
    version: 1,
    daemonUrl: `http://127.0.0.1:${port}`,
    token: daemonToken,
    projectId,
    processId: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`;

  try {
    await writeFile(temporaryFile, body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await rename(temporaryFile, connectionFile);
    } catch (error) {
      // Windows may refuse to replace an existing record. Remove the directory entry
      // before retrying so writeFile can never follow a hostile symlink target.
      if (!isNodeError(error) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code ?? "")) {
        throw error;
      }
      await rm(connectionFile, { force: true });
      await rename(temporaryFile, connectionFile);
    }
    ownedDaemonConnectionFile = connectionFile;
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeOwnedDaemonConnectionFile(): Promise<void> {
  const connectionFile = ownedDaemonConnectionFile;
  if (!connectionFile) {
    return;
  }
  let ownsRecord = false;
  try {
    const raw = await readFile(connectionFile, "utf8");
    const value = JSON.parse(raw) as { processId?: unknown; token?: unknown };
    if (value.processId !== process.pid || value.token !== daemonToken) {
      return;
    }
    ownsRecord = true;
  } catch {
    // A missing or malformed record should not be removed during shutdown.
  }
  if (ownsRecord) {
    await rm(connectionFile, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
