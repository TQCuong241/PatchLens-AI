import { useEffect, useMemo, useRef, useState } from "react";

import {
  PATCHLENS_MESSAGE_SOURCE,
  isInspectorMessage,
  type AgentChatResponse,
  type DaemonHealth,
  type StudioToInspectorMessage,
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

type StudioViewportPreset = Exclude<ViewportPreset, "custom">;

const VIEWPORT_PRESETS: Array<{
  id: StudioViewportPreset;
  label: string;
  portraitWidth?: number;
  landscapeWidth?: number;
}> = [
  { id: "desktop", label: "Desktop" },
  { id: "tablet", label: "Tablet", portraitWidth: 768, landscapeWidth: 1024 },
  { id: "mobile", label: "Mobile", portraitWidth: 390, landscapeWidth: 844 },
];

const DEFAULT_PREVIEW_URL = "http://127.0.0.1:4312";
const CHAT_WIDTH = 360;
const CHAT_ESTIMATED_HEIGHT = 330;

export function App() {
  const previewUrl = import.meta.env.VITE_PATCHLENS_PREVIEW_URL ?? DEFAULT_PREVIEW_URL;
  const previewOrigin = useMemo(() => new URL(previewUrl).origin, [previewUrl]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const deviceFrameRef = useRef<HTMLDivElement>(null);
  const activeSelectionIdRef = useRef<string | undefined>(undefined);
  const [selection, setSelection] = useState<VisualSelection>();
  const [inspectorReady, setInspectorReady] = useState(false);
  const [inspectorEnabled, setInspectorEnabled] = useState(true);
  const [daemonHealth, setDaemonHealth] = useState<DaemonHealth>();
  const [daemonError, setDaemonError] = useState<string>();
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize>({ width: 0, height: 0 });
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [isSending, setIsSending] = useState(false);
  const [viewportPreset, setViewportPreset] = useState<StudioViewportPreset>("desktop");
  const [viewportOrientation, setViewportOrientation] =
    useState<ViewportOrientation>("portrait");

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
        }
        setSelection(event.data.payload);
      }

      if (event.data.type === "inspector:selection-cleared") {
        activeSelectionIdRef.current = undefined;
        setSelection(undefined);
        setMessages([]);
        setSessionId(undefined);
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

  async function sendMessage(): Promise<void> {
    const value = instruction.trim();
    if (!selection || !value || isSending) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: value,
    };
    setMessages((current) => [...current, userMessage]);
    setInstruction("");
    setIsSending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          provider: "mock",
          instruction: value,
          selection: {
            ...selection,
            viewport: {
              ...selection.viewport,
              width: Math.round(surfaceSize.width || selection.viewport.width),
              height: Math.round(surfaceSize.height || selection.viewport.height),
              preset: viewportPreset,
              orientation: viewportPreset === "desktop" ? undefined : viewportOrientation,
            },
          },
          scopePolicy: "prefer-selection",
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

  const source = selection?.primaryElement.source;
  const activeViewport = VIEWPORT_PRESETS.find((preset) => preset.id === viewportPreset)
    ?? VIEWPORT_PRESETS[0]!;
  const activeViewportWidth = getViewportWidth(activeViewport, viewportOrientation);
  const canRotateViewport = viewportPreset !== "desktop";
  const viewportDescription = activeViewportWidth
    ? `${activeViewportWidth} px ${viewportOrientation}`
    : "Fluid desktop width";
  const deviceFrameClassName = [
    "device-frame",
    `device-frame-${viewportPreset}`,
    canRotateViewport ? `device-frame-${viewportOrientation}` : undefined,
  ].filter(Boolean).join(" ");
  const connectionLabel = daemonHealth
    ? "Local daemon connected"
    : daemonError
      ? "Daemon offline"
      : "Connecting to daemon";

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
          react-vite-demo
          <small>localhost:4312</small>
        </div>

        <div className="header-spacer" />

        <div className={`connection-state ${daemonHealth ? "is-online" : ""}`}>
          <span />
          {connectionLabel}
        </div>

        <label className="provider-picker">
          <span>Agent</span>
          <select aria-label="Coding agent" defaultValue="mock">
            <option value="mock">Mock Agent</option>
            <option value="codex" disabled>Codex · next</option>
            <option value="claude" disabled>Claude · planned</option>
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
          <button className="rail-button" type="button" disabled>
            <span aria-hidden="true">◫</span>
            Diff
          </button>
          <button className="rail-button" type="button" disabled>
            <span aria-hidden="true">↶</span>
            Undo
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

            <div
              className={`preview-surface preview-surface-${viewportPreset}`}
              aria-label={`${activeViewport.label} preview, ${viewportDescription}`}
            >
              <div className={deviceFrameClassName} ref={deviceFrameRef}>
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
                        Tell the agent what should change in this selected component.
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
                      placeholder="Make this CTA warmer and reduce its horizontal padding..."
                      aria-label="Describe the requested change"
                    />
                    <div className="composer-footer">
                      <span>{selection.confidence} mapping</span>
                      <button
                        type="button"
                        onClick={() => void sendMessage()}
                        disabled={!instruction.trim() || isSending}
                      >
                        Send to agent <span aria-hidden="true">↑</span>
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
                    {canRotateViewport ? ` · ${viewportOrientation}` : " · desktop"}
                  </dd>
                </div>
              </dl>

              <div className="scope-note">
                <span>Scope policy</span>
                <strong>Prefer selected component</strong>
                <p>The agent must report before expanding into shared files.</p>
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

          <div className="runtime-status">
            <div>
              <span>Inspector</span>
              <strong>{inspectorReady ? "Ready" : "Connecting"}</strong>
            </div>
            <div>
              <span>Daemon</span>
              <strong>{daemonHealth ? "Online" : "Offline"}</strong>
            </div>
            <div>
              <span>Agent bridge</span>
              <strong>Mock</strong>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function createMessageId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function getViewportWidth(
  preset: (typeof VIEWPORT_PRESETS)[number],
  orientation: ViewportOrientation,
): number | undefined {
  return orientation === "landscape"
    ? preset.landscapeWidth ?? preset.portraitWidth
    : preset.portraitWidth;
}

function formatViewportWidth(
  preset: (typeof VIEWPORT_PRESETS)[number],
  orientation: ViewportOrientation,
): string {
  const width = getViewportWidth(preset, orientation);
  return width ? `${width} px` : "Fluid";
}
