import { useEffect, useMemo, useRef, useState } from "react";

import {
  PATCHLENS_MESSAGE_SOURCE,
  isInspectorMessage,
  type AgentChatResponse,
  type DaemonHealth,
  type DaemonProjectInfo,
  type PatchTransaction,
  type PatchTransactionHistoryResponse,
  type ProviderId,
  type SelectionContext,
  type StudioToInspectorMessage,
  type UndoPatchTransactionResponse,
  type VisualSelection,
  type ViewportOrientation,
  type ViewportPreset,
} from "@patchlens-ai/agent-protocol";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type SurfaceSize = {
  width: number;
  height: number;
};

type DaemonErrorResponse = {
  message?: string;
  transaction?: PatchTransaction;
};

type PendingScopeApproval = {
  instruction: string;
  files: string[];
};

type StudioViewportPreset = ViewportPreset;

const VIEWPORT_PRESETS: Array<{
  id: StudioViewportPreset;
  label: string;
  portraitWidth?: number;
  landscapeWidth?: number;
}> = [
  { id: "desktop", label: "Desktop" },
  { id: "tablet", label: "Tablet", portraitWidth: 768, landscapeWidth: 1024 },
  { id: "mobile", label: "Mobile", portraitWidth: 390, landscapeWidth: 844 },
  { id: "custom", label: "Custom" },
];

const DEFAULT_PREVIEW_URL = "http://127.0.0.1:4312";
const CHAT_WIDTH = 360;
const CHAT_ESTIMATED_HEIGHT = 330;

export function App() {
  const configuredPreviewUrl = import.meta.env.VITE_PATCHLENS_PREVIEW_URL ?? DEFAULT_PREVIEW_URL;
  const [projectInfo, setProjectInfo] = useState<DaemonProjectInfo>();
  const previewUrl = projectInfo?.previewUrl ?? configuredPreviewUrl;
  const previewOrigin = useMemo(() => readUrlOrigin(previewUrl), [previewUrl]);
  const previewHost = useMemo(() => readUrlHost(previewUrl), [previewUrl]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const deviceFrameRef = useRef<HTMLDivElement>(null);
  const activeSelectionIdRef = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<VisualSelection>();
  const [selectionContext, setSelectionContext] = useState<SelectionContext>();
  const [inspectorReady, setInspectorReady] = useState(false);
  const [inspectorEnabled, setInspectorEnabled] = useState(true);
  const [daemonHealth, setDaemonHealth] = useState<DaemonHealth>();
  const [daemonError, setDaemonError] = useState<string>();
  const [daemonAuthenticated, setDaemonAuthenticated] = useState(false);
  const [daemonAuthError, setDaemonAuthError] = useState<string>();
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize>({ width: 0, height: 0 });
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [provider, setProvider] = useState<ProviderId>("mock");
  const [scopePolicy, setScopePolicy] =
    useState<"prefer-selection" | "strict" | "allow-related">("prefer-selection");
  const [pendingScopeApproval, setPendingScopeApproval] =
    useState<PendingScopeApproval>();
  const [isSending, setIsSending] = useState(false);
  const [transaction, setTransaction] = useState<PatchTransaction>();
  const [transactionHistory, setTransactionHistory] = useState<PatchTransaction[]>([]);
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [viewportPreset, setViewportPreset] = useState<StudioViewportPreset>("desktop");
  const [viewportOrientation, setViewportOrientation] =
    useState<ViewportOrientation>("portrait");
  const [customViewport, setCustomViewport] = useState({ width: 1280, height: 800 });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/session", {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => undefined) as
            | { message?: string }
            | undefined;
          throw new Error(body?.message ?? `Daemon returned ${response.status}`);
        }
        setDaemonAuthenticated(true);
        setDaemonAuthError(undefined);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setDaemonAuthenticated(false);
        setDaemonAuthError(
          error instanceof Error ? error.message : "Local daemon authentication failed",
        );
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Daemon returned ${response.status}`);
        }
        return (await response.json()) as DaemonHealth;
      })
      .then((health) => {
        setDaemonHealth(health);
        setDaemonError(undefined);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setDaemonError(error instanceof Error ? error.message : "Daemon is offline");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/project", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Daemon returned ${response.status}`);
        }
        return (await response.json()) as DaemonProjectInfo;
      })
      .then(setProjectInfo)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (daemonAuthenticated) {
      void refreshTransactionHistory();
    }
  }, [daemonAuthenticated]);

  useEffect(() => {
    function handleMessage(event: MessageEvent<unknown>): void {
      if (event.origin !== previewOrigin || !isInspectorMessage(event.data)) {
        return;
      }

      if (event.data.type === "inspector:ready") {
        setInspectorReady(true);
      }

      if (event.data.type === "inspector:selection") {
        if (activeSelectionIdRef.current !== event.data.payload.id) {
          activeSelectionIdRef.current = event.data.payload.id;
          setMessages([]);
          setSessionId(undefined);
          setSelectionContext(undefined);
          setPendingScopeApproval(undefined);
          setIsDiffOpen(false);
        }
        setSelection(event.data.payload);
      }

      if (event.data.type === "inspector:selection-context") {
        if (event.data.payload.selection.id === activeSelectionIdRef.current) {
          setSelectionContext(event.data.payload);
        }
      }

      if (event.data.type === "inspector:selection-cleared") {
        activeSelectionIdRef.current = undefined;
        setSelection(undefined);
        setSelectionContext(undefined);
        setMessages([]);
        setSessionId(undefined);
        setPendingScopeApproval(undefined);
        setIsDiffOpen(false);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [previewOrigin]);

  useEffect(() => {
    const surface = deviceFrameRef.current;
    if (!surface) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      setSurfaceSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!daemonAuthenticated) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const synchronizedSelection = selection
        ? withStudioViewport(
            selection,
            surfaceSize,
            viewportPreset,
            viewportOrientation,
          )
        : undefined;
      const request = selection
        ? fetch("/api/selection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              selection: synchronizedSelection,
              context: selectionContext && synchronizedSelection
                ? { ...selectionContext, selection: synchronizedSelection }
                : undefined,
            }),
          })
        : fetch("/api/selection/clear", {
            method: "POST",
            signal: controller.signal,
          });
      void request.catch(() => undefined);
    }, 80);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    selection,
    selectionContext,
    surfaceSize,
    viewportOrientation,
    viewportPreset,
    daemonAuthenticated,
  ]);

  const chatPosition = useMemo(() => {
    if (!selection) {
      return undefined;
    }

    const desiredLeft = selection.rectangle.x;
    const left = Math.max(
      12,
      Math.min(desiredLeft, Math.max(12, surfaceSize.width - CHAT_WIDTH - 12)),
    );
    const below = selection.rectangle.y + selection.rectangle.height + 12;
    const top = below + CHAT_ESTIMATED_HEIGHT <= surfaceSize.height
      ? below
      : Math.max(12, selection.rectangle.y - CHAT_ESTIMATED_HEIGHT - 12);

    return { left, top };
  }, [selection, surfaceSize]);

  function postToInspector(message: StudioToInspectorMessage): void {
    iframeRef.current?.contentWindow?.postMessage(message, previewOrigin);
  }

  function toggleInspector(): void {
    const nextEnabled = !inspectorEnabled;
    setInspectorEnabled(nextEnabled);
    postToInspector({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "studio:set-inspector-mode",
      payload: { enabled: nextEnabled },
    });
  }

  function clearSelection(): void {
    postToInspector({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "studio:clear-selection",
    });
  }

  function changeProvider(nextProvider: ProviderId): void {
    if (nextProvider === provider) {
      return;
    }
    setProvider(nextProvider);
    setSessionId(undefined);
    setMessages([]);
    setPendingScopeApproval(undefined);
  }

  async function refreshTransactionHistory(): Promise<void> {
    if (!daemonAuthenticated) {
      return;
    }
    try {
      const response = await fetch("/api/transactions");
      if (!response.ok) {
        return;
      }
      const result = (await response.json()) as PatchTransactionHistoryResponse;
      setTransactionHistory(result.transactions);
      if (!transaction && result.transactions[0]) {
        setTransaction(result.transactions[0]);
      }
    } catch {
      // History is optional while the daemon is connecting.
    }
  }

  async function sendMessage(options: {
    value?: string;
    approvedScopeExpansion?: string[];
    appendUserMessage?: boolean;
  } = {}): Promise<void> {
    const value = (options.value ?? instruction).trim();
    if (!selection || !value || isSending || !daemonAuthenticated) {
      return;
    }

    const appendUserMessage = options.appendUserMessage ?? true;
    const conversation = [
      ...messages.map(({ role, content }) => ({ role, content })),
      ...(appendUserMessage ? [{ role: "user" as const, content: value }] : []),
    ].slice(-20);
    if (appendUserMessage) {
      const userMessage: ChatMessage = {
        id: createMessageId(),
        role: "user",
        content: value,
      };
      setMessages((current) => [...current, userMessage]);
      setInstruction("");
    }
    setIsSending(true);
    setPendingScopeApproval(undefined);
    const requestSessionId = sessionId ?? createSessionId();
    if (!sessionId) {
      setSessionId(requestSessionId);
    }

    try {
      const requestSelection = withStudioViewport(
        selection,
        surfaceSize,
        viewportPreset,
        viewportOrientation,
      );
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: requestSessionId,
          provider,
          instruction: value,
          selection: requestSelection,
          context: selectionContext
            ? { ...selectionContext, selection: requestSelection }
            : undefined,
          conversation,
          scopePolicy,
          approvedScopeExpansion: options.approvedScopeExpansion,
        }),
      });

      const result = (await response.json()) as AgentChatResponse | { message?: string };
      if (!response.ok) {
        const message = "message" in result ? result.message : undefined;
        throw new Error(message ?? `Daemon returned ${response.status}`);
      }

      if (!("reply" in result)) {
        throw new Error("Daemon response did not include an agent reply.");
      }

      setSessionId(result.session.id);
      if (result.transaction) {
        setTransaction(result.transaction);
        setIsDiffOpen(true);
        void refreshTransactionHistory();
      }
      if (result.scopeExpansionRequired?.length) {
        setPendingScopeApproval({
          instruction: value,
          files: result.scopeExpansionRequired,
        });
      }
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: result.reply,
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: error instanceof Error
            ? `The daemon could not process this request: ${error.message}`
            : "The daemon could not process this request.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  async function cancelProviderRequest(): Promise<void> {
    if (!sessionId || !isSending) {
      return;
    }
    try {
      await fetch(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
    } catch {
      // The active chat request reports the final cancellation result.
    }
  }

  async function approveScopeExpansion(): Promise<void> {
    if (!pendingScopeApproval) {
      return;
    }
    const pending = pendingScopeApproval;
    await sendMessage({
      value: pending.instruction,
      approvedScopeExpansion: pending.files,
      appendUserMessage: false,
    });
  }

  async function undoTransaction(): Promise<void> {
    if (!transaction?.undoAvailable || isUndoing) {
      return;
    }

    setIsUndoing(true);
    try {
      const response = await fetch(`/api/transactions/${transaction.id}/undo`, {
        method: "POST",
      });
      const result = (await response.json()) as
        | UndoPatchTransactionResponse
        | DaemonErrorResponse;

      if (!response.ok) {
        if (result.transaction) {
          setTransaction(result.transaction);
        }
        throw new Error(result.message ?? `Daemon returned ${response.status}`);
      }

      if (!result.transaction || typeof result.message !== "string") {
        throw new Error("Daemon response did not include the reverted transaction.");
      }

      setTransaction(result.transaction);
      void refreshTransactionHistory();
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: result.message,
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: error instanceof Error
            ? `Undo stopped safely: ${error.message}`
            : "Undo stopped safely because the transaction could not be verified.",
        },
      ]);
    } finally {
      setIsUndoing(false);
    }
  }

  const source = selection?.primaryElement.source;
  const activeViewport = VIEWPORT_PRESETS.find((preset) => preset.id === viewportPreset)
    ?? VIEWPORT_PRESETS[0]!;
  const activeViewportWidth = getViewportWidth(
    activeViewport,
    viewportOrientation,
    customViewport,
  );
  const canRotateViewport = viewportPreset === "tablet" || viewportPreset === "mobile";
  const viewportDescription = viewportPreset === "custom"
    ? `${customViewport.width} x ${customViewport.height} px`
    : activeViewportWidth
      ? `${activeViewportWidth} px ${viewportOrientation}`
      : "Fluid desktop width";
  const deviceFrameClassName = [
    "device-frame",
    `device-frame-${viewportPreset}`,
    canRotateViewport ? `device-frame-${viewportOrientation}` : undefined,
  ].filter(Boolean).join(" ");
  const deviceFrameStyle = viewportPreset === "custom"
    ? {
        width: customViewport.width,
        minWidth: customViewport.width,
        height: customViewport.height,
        flexBasis: customViewport.width,
      }
    : undefined;
  const transactionStats = transaction
    ? transaction.files.reduce(
        (totals, file) => ({
          additions: totals.additions + file.additions,
          deletions: totals.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      )
    : undefined;
  const connectionLabel = daemonHealth
    ? daemonAuthenticated
      ? "Local daemon secured"
      : daemonAuthError
        ? "Daemon authentication failed"
        : "Securing local daemon"
    : daemonError
      ? "Daemon offline"
      : "Connecting to daemon";
  const activeProviderState = daemonHealth?.providers.find((item) => item.id === provider);
  const providerLabel = activeProviderState?.status === "available"
    ? provider === "mock"
      ? "Mock"
      : `${provider} CLI`
    : `${provider} unavailable`;

  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="studio-brand">
          <span className="studio-mark" aria-hidden="true">⌖</span>
          <div>
            <strong>PatchLens AI</strong>
            <span>Visual context studio</span>
          </div>
        </div>

        <div className="project-chip">
          <span className="project-dot" />
          {projectInfo?.projectId ?? "local project"}
          <small>{previewHost}</small>
        </div>

        <div className="header-spacer" />

        <div className={`connection-state ${daemonHealth && daemonAuthenticated ? "is-online" : ""}`}>
          <span />
          {connectionLabel}
        </div>

        <label className="provider-picker">
          <span>Agent</span>
          <select
            aria-label="Coding agent"
            value={provider}
            onChange={(event) => changeProvider(event.target.value)}
          >
            <option value="mock">Mock Agent</option>
            <option
              value="codex"
              disabled={daemonHealth?.providers.find((item) => item.id === "codex")?.status !== "available"}
            >
              Codex CLI
            </option>
            <option
              value="claude"
              disabled={daemonHealth?.providers.find((item) => item.id === "claude")?.status !== "available"}
            >
              Claude Code CLI
            </option>
          </select>
        </label>
      </header>

      <div className="studio-layout">
        <aside className="tool-rail" aria-label="PatchLens tools">
          <button
            className={inspectorEnabled ? "rail-button is-active" : "rail-button"}
            type="button"
            onClick={toggleInspector}
            aria-pressed={inspectorEnabled}
          >
            <span aria-hidden="true">⌁</span>
            Select
          </button>
          <button
            className={isDiffOpen ? "rail-button is-active" : "rail-button"}
            type="button"
            onClick={() => {
              setIsHistoryOpen(false);
              setIsDiffOpen((current) => !current);
            }}
            disabled={!transaction}
            aria-pressed={isDiffOpen}
          >
            <span aria-hidden="true">◫</span>
            Diff
          </button>
          <button
            className={isHistoryOpen ? "rail-button is-active" : "rail-button"}
            type="button"
            onClick={() => {
              setIsDiffOpen(false);
              setIsHistoryOpen((current) => !current);
            }}
            disabled={transactionHistory.length === 0}
            aria-pressed={isHistoryOpen}
          >
            <span aria-hidden="true">#</span>
            History
          </button>
          <button
            className="rail-button"
            type="button"
            onClick={() => void undoTransaction()}
            disabled={!transaction?.undoAvailable || isUndoing}
          >
            <span aria-hidden="true">↶</span>
            {isUndoing ? "Undoing" : "Undo"}
          </button>
          <div className="rail-spacer" />
          <span className="version-label">v0.0.0</span>
        </aside>

        <main className="workspace">
          <div className="workspace-heading">
            <div>
              <p>Live development surface</p>
              <h1>Select what you mean.</h1>
            </div>
            <div className="workspace-instruction">
              <span className={inspectorReady ? "instruction-light is-ready" : "instruction-light"} />
              {inspectorReady
                ? inspectorEnabled
                  ? "Click an element or drag across a region"
                  : "Inspector paused — interact with the preview"
                : "Waiting for the preview inspector"}
            </div>
          </div>

          <section className="preview-window" aria-label="Application preview">
            <div className="preview-chrome">
              <div className="window-dots" aria-hidden="true">
                <span /><span /><span />
              </div>
              <div className="address-bar">
                <span>◉</span>
                {previewUrl}
              </div>
              <div className="viewport-switcher" role="group" aria-label="Preview viewport">
                {VIEWPORT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={viewportPreset === preset.id ? "is-active" : ""}
                    onClick={() => setViewportPreset(preset.id)}
                    aria-pressed={viewportPreset === preset.id}
                    title={`${preset.label} viewport · ${formatViewportWidth(
                      preset,
                      preset.id === viewportPreset ? viewportOrientation : "portrait",
                      customViewport,
                    )}`}
                  >
                    <span
                      className={`viewport-icon viewport-icon-${preset.id}`}
                      aria-hidden="true"
                    />
                    <strong>{preset.label}</strong>
                    <small>
                      {formatViewportWidth(
                        preset,
                        preset.id === viewportPreset ? viewportOrientation : "portrait",
                        customViewport,
                      )}
                    </small>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="chrome-action orientation-action"
                onClick={() => {
                  setViewportOrientation((current) =>
                    current === "portrait" ? "landscape" : "portrait",
                  );
                }}
                disabled={!canRotateViewport}
                aria-label={`Rotate ${activeViewport.label} viewport`}
                title={canRotateViewport
                  ? `Rotate viewport · currently ${viewportOrientation}`
                  : "Choose Tablet or Mobile to rotate the viewport"}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M6.2 3.5h7.6a2 2 0 0 1 2 2v5.7" />
                  <path d="m13.2 9.3 2.6 2.6 2.6-2.6" />
                  <path d="M13.8 16.5H6.2a2 2 0 0 1-2-2V8.8" />
                  <path d="m6.8 10.7-2.6-2.6-2.6 2.6" />
                </svg>
              </button>
              <button
                type="button"
                className="chrome-action"
                onClick={() => {
                  if (iframeRef.current) {
                    iframeRef.current.src = iframeRef.current.src;
                  }
                }}
                aria-label="Reload preview"
              >
                ↻
              </button>
            </div>

            {viewportPreset === "custom" ? (
              <div className="custom-viewport-bar" aria-label="Custom preview dimensions">
                <span>Custom viewport</span>
                <label>
                  Width
                  <input
                    type="number"
                    min="320"
                    max="3840"
                    step="1"
                    value={customViewport.width}
                    onChange={(event) => setCustomViewport((current) => ({
                      ...current,
                      width: clampViewportDimension(event.target.value, 320, 3840),
                    }))}
                  />
                </label>
                <span aria-hidden="true">×</span>
                <label>
                  Height
                  <input
                    type="number"
                    min="320"
                    max="2160"
                    step="1"
                    value={customViewport.height}
                    onChange={(event) => setCustomViewport((current) => ({
                      ...current,
                      height: clampViewportDimension(event.target.value, 320, 2160),
                    }))}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setCustomViewport({ width: 1280, height: 800 })}
                >
                  Reset
                </button>
              </div>
            ) : null}

            <div
              className={`preview-surface preview-surface-${viewportPreset}`}
              aria-label={`${activeViewport.label} preview, ${viewportDescription}`}
            >
              <div
                className={deviceFrameClassName}
                ref={deviceFrameRef}
                style={deviceFrameStyle}
              >
                <iframe
                  ref={iframeRef}
                  title="PatchLens demo preview"
                  src={previewUrl}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  onLoad={() => {
                    setInspectorReady(false);
                    window.setTimeout(() => {
                      postToInspector({
                        source: PATCHLENS_MESSAGE_SOURCE,
                        type: "studio:set-inspector-mode",
                        payload: { enabled: inspectorEnabled },
                      });
                    }, 100);
                  }}
                />

                {selection && chatPosition ? (
                  <section
                    className="anchored-chat"
                    style={{ left: chatPosition.left, top: chatPosition.top }}
                    aria-label="Chat for selected component"
                  >
                    <header className="chat-header">
                      <div>
                        <span>Selected context</span>
                        <strong>{source?.componentName ?? selection.primaryElement.tagName}</strong>
                        <code>
                          {source
                            ? `${source.file}:${source.line}`
                            : "Visual-only selection"}
                        </code>
                      </div>
                      <button type="button" onClick={clearSelection} aria-label="Close selection">
                        ×
                      </button>
                    </header>

                    <div className="context-row">
                      <span>Image region</span>
                      <span>DOM</span>
                      <span className={source ? "is-resolved" : ""}>Source</span>
                    </div>

                    <div className="chat-thread">
                      {messages.length === 0 ? (
                        <p className="chat-empty">
                          Tell the agent what should change. Try <code>text: Launch workspace</code>
                          {" "}to run the safe mock patch flow.
                        </p>
                      ) : (
                        messages.map((message) => (
                          <div
                            className={`chat-message chat-message-${message.role}`}
                            key={message.id}
                          >
                            {message.content}
                          </div>
                        ))
                      )}
                      {pendingScopeApproval ? (
                        <div className="scope-approval-card">
                          <strong>Related files need approval</strong>
                          <span>{pendingScopeApproval.files.join(", ")}</span>
                          <button
                            type="button"
                            onClick={() => void approveScopeExpansion()}
                            disabled={isSending}
                          >
                            Approve these files
                          </button>
                        </div>
                      ) : null}
                      {isSending ? (
                        <div className="agent-thinking">
                          <span /><span /><span />
                          Resolving selected context
                        </div>
                      ) : null}
                    </div>

                    <div className="chat-composer">
                      <textarea
                        value={instruction}
                        onChange={(event) => setInstruction(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            void sendMessage();
                          }
                        }}
                        placeholder={provider === "mock"
                          ? "Describe the change, or try: text: Launch workspace"
                          : `Describe the change for ${provider}`}
                        aria-label="Describe the requested change"
                      />
                      <div className="composer-footer">
                        <span>{selection.confidence} mapping</span>
                        <button
                          type="button"
                          onClick={() => {
                            if (isSending) {
                              void cancelProviderRequest();
                            } else {
                              void sendMessage();
                            }
                          }}
                          disabled={isSending
                            ? !sessionId
                            : !instruction.trim() || !daemonAuthenticated}
                        >
                          {isSending ? "Stop agent" : `Send to ${provider}`}
                          <span aria-hidden="true">{isSending ? "■" : "↑"}</span>
                        </button>
                      </div>
                    </div>
                  </section>
                ) : null}
              </div>
            </div>
          </section>
        </main>

        <aside className="context-panel">
          <div className="context-panel-heading">
            <span>Selection context</span>
            <strong>{selection ? "Resolved" : "Waiting"}</strong>
          </div>

          {selection ? (
            <>
              <div className="selected-summary">
                <span className="summary-kicker">Primary component</span>
                <h2>{source?.componentName ?? selection.primaryElement.tagName}</h2>
                <p>{selection.primaryElement.text || "No visible text"}</p>
              </div>

              <dl className="context-details">
                <div>
                  <dt>Confidence</dt>
                  <dd className="confidence-value">{selection.confidence}</dd>
                </div>
                <div>
                  <dt>Source file</dt>
                  <dd>{source?.file ?? "Agent lookup required"}</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>{source ? `Line ${source.line}, column ${source.column}` : "Visual only"}</dd>
                </div>
                <div>
                  <dt>Elements</dt>
                  <dd>{selection.elements.length}</dd>
                </div>
                <div>
                  <dt>Route</dt>
                  <dd>{selection.route || "/"}</dd>
                </div>
                <div>
                  <dt>Viewport</dt>
                  <dd>
                    {Math.round(surfaceSize.width || selection.viewport.width)} × {Math.round(
                      surfaceSize.height || selection.viewport.height,
                    )}
                    {viewportPreset === "custom"
                      ? " · custom"
                      : canRotateViewport
                        ? ` · ${viewportOrientation}`
                        : " · desktop"}
                  </dd>
                </div>
              </dl>

              <div className="scope-note">
                <span>Scope policy</span>
                <select
                  value={scopePolicy}
                  onChange={(event) => setScopePolicy(event.target.value as typeof scopePolicy)}
                  aria-label="Agent file scope policy"
                >
                  <option value="prefer-selection">Ask before related files</option>
                  <option value="strict">Selected source only</option>
                  <option value="allow-related">Allow related files</option>
                </select>
                <p>
                  {scopePolicy === "prefer-selection"
                    ? "The agent must ask before expanding into shared files."
                    : scopePolicy === "strict"
                      ? "Changes outside the selected source are rejected."
                      : "Related files may be changed and remain visible in one transaction."}
                </p>
              </div>

              <div className="context-capture-grid">
                <div>
                  <span>Context payload</span>
                  <strong>{selectionContext
                    ? `${Math.max(1, Math.round(selectionContext.approximateBytes / 1024))} KB`
                    : "Capturing"}</strong>
                </div>
                <div>
                  <span>Computed styles</span>
                  <strong>{selectionContext
                    ? Object.keys(selectionContext.computedStyles).length
                    : 0}</strong>
                </div>
                <div>
                  <span>Runtime errors</span>
                  <strong>{selectionContext?.consoleErrors.length ?? 0}</strong>
                </div>
              </div>

            </>
          ) : (
            <div className="context-empty">
              <span className="context-target" aria-hidden="true">⌖</span>
              <h2>No component selected</h2>
              <p>
                Hover the preview, then click an element or drag around a group.
              </p>
            </div>
          )}

          {transaction && transactionStats ? (
            <div className={`transaction-card transaction-card-${transaction.status}`}>
              <span>Latest patch transaction</span>
              <strong>{formatTransactionStatus(transaction.status)}</strong>
              <p>
                {transaction.files.length} file · +{transactionStats.additions}
                {" "}/ -{transactionStats.deletions}
              </p>
              {transaction.verification ? (
                <small>
                  Verification: {formatVerificationStatus(transaction.verification.status)}
                </small>
              ) : null}
              <div className="transaction-card-actions">
                <button type="button" onClick={() => setIsDiffOpen(true)}>
                  Review diff
                </button>
                <button
                  type="button"
                  onClick={() => void undoTransaction()}
                  disabled={!transaction.undoAvailable || isUndoing}
                >
                  {isUndoing ? "Checking…" : "Safe undo"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="runtime-status">
            <div>
              <span>Inspector</span>
              <strong>{inspectorReady ? "Ready" : "Connecting"}</strong>
            </div>
            <div>
              <span>Daemon</span>
              <strong>{daemonAuthenticated ? "Secured" : daemonHealth ? "Connecting" : "Offline"}</strong>
            </div>
            <div>
              <span>Agent bridge</span>
              <strong>{providerLabel}</strong>
            </div>
            <div>
              <span>Patch safety</span>
              <strong>{transaction ? formatTransactionStatus(transaction.status) : "Ready"}</strong>
            </div>
          </div>
        </aside>
      </div>

      {isHistoryOpen ? (
        <div className="transaction-layer">
          <button
            type="button"
            className="transaction-backdrop"
            onClick={() => setIsHistoryOpen(false)}
            aria-label="Close patch history"
          />
          <aside className="transaction-drawer history-drawer" aria-label="Patch history">
            <header className="transaction-drawer-header">
              <div>
                <span>Persistent local history</span>
                <h2>Patch transactions</h2>
                <code>{transactionHistory.length} recorded</code>
              </div>
              <button
                type="button"
                onClick={() => setIsHistoryOpen(false)}
                aria-label="Close patch history"
              >
                ×
              </button>
            </header>

            <div className="history-list">
              {transactionHistory.map((historyItem) => {
                const totals = historyItem.files.reduce(
                  (current, file) => ({
                    additions: current.additions + file.additions,
                    deletions: current.deletions + file.deletions,
                  }),
                  { additions: 0, deletions: 0 },
                );
                return (
                  <button
                    type="button"
                    className="history-item"
                    key={historyItem.id}
                    onClick={() => {
                      setTransaction(historyItem);
                      setIsHistoryOpen(false);
                      setIsDiffOpen(true);
                    }}
                  >
                    <span>{formatTransactionStatus(historyItem.status)}</span>
                    <strong>{historyItem.instruction}</strong>
                    <small>
                      {historyItem.files.length} file · +{totals.additions} / -{totals.deletions}
                    </small>
                    <time>{new Date(historyItem.createdAt).toLocaleString()}</time>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      ) : null}

      {transaction && transactionStats && isDiffOpen ? (
        <div className="transaction-layer">
          <button
            type="button"
            className="transaction-backdrop"
            onClick={() => setIsDiffOpen(false)}
            aria-label="Close patch transaction review"
          />
          <aside className="transaction-drawer" aria-label="Patch transaction review">
            <header className="transaction-drawer-header">
              <div>
                <span>Patch transaction</span>
                <h2>{formatTransactionStatus(transaction.status)}</h2>
                <code>{transaction.id}</code>
              </div>
              <button
                type="button"
                onClick={() => setIsDiffOpen(false)}
                aria-label="Close diff review"
              >
                ×
              </button>
            </header>

            <div className="transaction-metrics">
              <div>
                <span>Files</span>
                <strong>{transaction.files.length}</strong>
              </div>
              <div>
                <span>Added</span>
                <strong className="metric-addition">+{transactionStats.additions}</strong>
              </div>
              <div>
                <span>Removed</span>
                <strong className="metric-deletion">-{transactionStats.deletions}</strong>
              </div>
              <div>
                <span>Undo</span>
                <strong>{transaction.undoAvailable ? "Ready" : "Locked"}</strong>
              </div>
            </div>

            <div className="transaction-instruction">
              <span>Developer request</span>
              <p>{transaction.instruction}</p>
            </div>

            {transaction.verification ? (
              <div className={`transaction-verification verification-${transaction.verification.status}`}>
                <header>
                  <span>Runtime verification</span>
                  <strong>{formatVerificationStatus(transaction.verification.status)}</strong>
                </header>
                {transaction.verification.checks.map((check) => (
                  <div key={check.name}>
                    <span>{check.name}</span>
                    <strong>{check.status}</strong>
                    <p>{check.detail}</p>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="transaction-files">
              {transaction.files.map((file) => (
                <section className="transaction-file" key={file.file}>
                  <header>
                    <code>{file.file}</code>
                    <span>+{file.additions} / -{file.deletions}</span>
                  </header>
                  <pre><code>{file.diff}</code></pre>
                </section>
              ))}
            </div>

            <footer className="transaction-drawer-footer">
              <p>
                Undo proceeds only while every changed file still matches this transaction.
              </p>
              <button
                type="button"
                onClick={() => void undoTransaction()}
                disabled={!transaction.undoAvailable || isUndoing}
              >
                {isUndoing ? "Verifying files…" : "Undo agent patch"}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function createMessageId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function createSessionId(): string {
  return `session_${createMessageId()}`;
}

function formatTransactionStatus(status: PatchTransaction["status"]): string {
  switch (status) {
    case "applied":
      return "Applied and reviewable";
    case "reverted":
      return "Reverted safely";
    case "conflicted":
      return "Undo blocked by newer edits";
    case "failed":
      return "Patch failed";
    default:
      return "Patch in progress";
  }
}

function formatVerificationStatus(
  status: NonNullable<PatchTransaction["verification"]>["status"],
): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "partial":
      return "Preview reachable; browser checks pending";
    case "failed":
      return "Preview check failed";
    default:
      return "Skipped";
  }
}

function getViewportWidth(
  preset: (typeof VIEWPORT_PRESETS)[number],
  orientation: ViewportOrientation,
  customViewport: { width: number; height: number },
): number | undefined {
  if (preset.id === "custom") {
    return customViewport.width;
  }
  return orientation === "landscape"
    ? preset.landscapeWidth ?? preset.portraitWidth
    : preset.portraitWidth;
}

function withStudioViewport(
  selection: VisualSelection,
  surfaceSize: SurfaceSize,
  preset: StudioViewportPreset,
  orientation: ViewportOrientation,
): VisualSelection {
  return {
    ...selection,
    viewport: {
      ...selection.viewport,
      width: Math.round(surfaceSize.width || selection.viewport.width),
      height: Math.round(surfaceSize.height || selection.viewport.height),
      preset,
      orientation: preset === "tablet" || preset === "mobile" ? orientation : undefined,
    },
  };
}

function formatViewportWidth(
  preset: (typeof VIEWPORT_PRESETS)[number],
  orientation: ViewportOrientation,
  customViewport: { width: number; height: number },
): string {
  if (preset.id === "custom") {
    return `${customViewport.width} x ${customViewport.height}`;
  }
  const width = getViewportWidth(preset, orientation, customViewport);
  return width ? `${width} px` : "Fluid";
}

function clampViewportDimension(value: string, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function readUrlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function readUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "preview unavailable";
  }
}
