import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_LIMITS,
  PATCHLENS_PROTOCOL_VERSION,
  parseInspectorMessage,
} from '@patchlens-ai/agent-protocol';
import type {
  AgentEvent,
  AgentRequest,
  AgentSession,
  InspectorSelectionContext,
  ProviderId,
  ScreenshotReference,
  SelectionContext,
  StudioClearSelectionMessage,
  StudioSetInspectorModeMessage,
  VisualSelection,
  VisualComparison,
} from '@patchlens-ai/agent-protocol';
import { DaemonClient } from '@patchlens-ai/daemon-client';
import { MockCodingProvider } from '@patchlens-ai/provider-mock';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';

const fallbackProjectId = 'patchlens-demo';
const runtimeConfig = readRuntimeConfig();
const defaultPreviewUrl = runtimeConfig.previewUrl ?? 'http://127.0.0.1:4311';
const daemonUrl = runtimeConfig.daemonUrl ?? import.meta.env.VITE_PATCHLENS_DAEMON_URL;
const daemonToken = runtimeConfig.daemonToken ?? import.meta.env.VITE_PATCHLENS_DAEMON_TOKEN;
const configuredProjectRoot =
  runtimeConfig.projectRoot ?? import.meta.env.VITE_PATCHLENS_PROJECT_ROOT;
const configuredProvider = (runtimeConfig.provider ?? 'mock') as ProviderId;
const configuredProjectId = runtimeConfig.projectId;

type StudioRuntimeConfig = {
  mode?: string;
  daemonUrl?: string;
  daemonToken?: string;
  projectRoot?: string;
  previewUrl?: string;
  provider?: string;
  projectId?: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'status';
  content: string;
};

type ChatThread = {
  messages: ChatMessage[];
  status: 'idle' | 'running' | 'complete' | 'failed';
  files: string[];
  diff?: { transactionId: string; content: string };
  verification?: {
    ok: boolean;
    summary: string;
    commands: string[];
    beforeScreenshot?: ScreenshotReference;
    afterScreenshot?: ScreenshotReference;
    visualComparison?: VisualComparison;
    beforeImageUrl?: string;
    afterImageUrl?: string;
  };
};

const emptyThread: ChatThread = {
  messages: [],
  status: 'idle',
  files: [],
};

export function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<AgentSession | undefined>(undefined);
  const activeSelectionIdRef = useRef<string | undefined>(undefined);
  const contextBySelectionRef = useRef(new Map<string, SelectionContext>());
  const contextGenerationRef = useRef(0);
  const contextGenerationBySelectionRef = useRef(new Map<string, number>());
  const captureUrlsRef = useRef(new Set<string>());
  const captureUrlsBySelectionRef = useRef(new Map<string, { before?: string; after?: string }>());
  const channelId = useMemo(() => createId('channel'), []);
  const provider = useMemo(() => new MockCodingProvider(), []);
  const daemonClient = useMemo(
    () =>
      daemonUrl && daemonToken
        ? new DaemonClient({ baseUrl: daemonUrl, token: daemonToken })
        : undefined,
    [],
  );
  const [previewDraft, setPreviewDraft] = useState(defaultPreviewUrl);
  const [previewBaseUrl, setPreviewBaseUrl] = useState(defaultPreviewUrl);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [projectId, setProjectId] = useState(configuredProjectId ?? fallbackProjectId);
  const [daemonStatus, setDaemonStatus] = useState<'offline' | 'connecting' | 'ready' | 'failed'>(
    daemonClient ? 'connecting' : 'offline',
  );
  const [selection, setSelection] = useState<VisualSelection>();
  const [contextSelectionId, setContextSelectionId] = useState<string>();
  const [chatDraft, setChatDraft] = useState('');
  const [threads, setThreads] = useState<Record<string, ChatThread>>({});
  const previewOrigin = getOrigin(previewBaseUrl);
  const activeDaemonClient = daemonStatus === 'ready' ? daemonClient : undefined;
  const previewUrl =
    daemonClient && daemonStatus === 'connecting'
      ? undefined
      : buildPreviewUrl(previewBaseUrl, projectId, channelId);

  useEffect(
    () => () => {
      for (const url of captureUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      captureUrlsRef.current.clear();
      captureUrlsBySelectionRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!daemonClient) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await daemonClient.health();
        const projectId = configuredProjectId
          ? configuredProjectId
          : configuredProjectRoot
            ? (await daemonClient.registerProject(configuredProjectRoot)).id
            : undefined;
        if (!projectId) {
          throw new Error('Studio project configuration is missing');
        }
        if (!cancelled) {
          sessionRef.current = undefined;
          setProjectId(projectId);
          setDaemonStatus('ready');
        }
      } catch {
        if (!cancelled) {
          setDaemonStatus('failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [daemonClient]);

  useEffect(() => {
    function handleMessage(event: MessageEvent<unknown>) {
      if (
        !previewOrigin ||
        event.origin !== previewOrigin ||
        event.source !== iframeRef.current?.contentWindow
      ) {
        return;
      }

      const parsed = parseInspectorMessage(event.data);
      if (!parsed.success) {
        return;
      }

      const message = parsed.data;
      if (message.channelId !== channelId || message.projectId !== projectId) {
        return;
      }

      if (message.type === 'inspector:ready') {
        setReady(true);
        postInspectorMode(enabled);
        return;
      }

      if (message.type === 'inspector:selection') {
        const previousSelectionId = activeSelectionIdRef.current;
        if (previousSelectionId && previousSelectionId !== message.payload.id) {
          contextGenerationBySelectionRef.current.delete(previousSelectionId);
        }
        contextGenerationRef.current += 1;
        const generation = contextGenerationRef.current;
        contextGenerationBySelectionRef.current.set(message.payload.id, generation);
        activeSelectionIdRef.current = message.payload.id;
        setSelection(message.payload);
        setContextSelectionId(undefined);
        const preliminaryContext = createSelectionContext(message.payload);
        contextBySelectionRef.current.set(message.payload.id, preliminaryContext);
        if (activeDaemonClient) {
          void activeDaemonClient.setSelection(projectId, preliminaryContext).catch(() => {
            if (
              activeSelectionIdRef.current === message.payload.id &&
              contextGenerationBySelectionRef.current.get(message.payload.id) === generation
            ) {
              setDaemonStatus('failed');
            }
          });
        }
        return;
      }

      if (message.type === 'inspector:context') {
        if (activeSelectionIdRef.current !== message.payload.selection.id) {
          return;
        }
        contextGenerationRef.current += 1;
        const generation = contextGenerationRef.current;
        contextGenerationBySelectionRef.current.set(message.payload.selection.id, generation);
        setSelection(message.payload.selection);
        void persistInspectorContext(message.payload, generation).catch(() => {
          if (
            activeSelectionIdRef.current === message.payload.selection.id &&
            contextGenerationBySelectionRef.current.get(message.payload.selection.id) === generation
          ) {
            setDaemonStatus('failed');
          }
        });
        return;
      }

      if (message.payload.selectionId) {
        contextBySelectionRef.current.delete(message.payload.selectionId);
        contextGenerationBySelectionRef.current.delete(message.payload.selectionId);
      }
      if (activeSelectionIdRef.current) {
        contextGenerationBySelectionRef.current.delete(activeSelectionIdRef.current);
      }
      activeSelectionIdRef.current = undefined;
      setContextSelectionId(undefined);
      setSelection(undefined);
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeDaemonClient, channelId, enabled, previewOrigin, projectId]);

  function connectPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!getOrigin(previewDraft)) {
      return;
    }

    setReady(false);
    activeSelectionIdRef.current = undefined;
    contextBySelectionRef.current.clear();
    contextGenerationBySelectionRef.current.clear();
    setContextSelectionId(undefined);
    setSelection(undefined);
    setPreviewBaseUrl(previewDraft);
  }

  function toggleInspector(): void {
    const nextEnabled = !enabled;
    setEnabled(nextEnabled);
    postInspectorMode(nextEnabled);
  }

  function postInspectorMode(nextEnabled: boolean): void {
    if (!previewOrigin) {
      return;
    }

    const message: StudioSetInspectorModeMessage = {
      source: PATCHLENS_MESSAGE_SOURCE,
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      messageId: createId('message'),
      channelId,
      projectId,
      type: 'studio:set-inspector-mode',
      payload: { enabled: nextEnabled },
    };
    iframeRef.current?.contentWindow?.postMessage(message, previewOrigin);
  }

  function clearSelection(): void {
    if (!previewOrigin) {
      return;
    }

    const message: StudioClearSelectionMessage = {
      source: PATCHLENS_MESSAGE_SOURCE,
      schemaVersion: PATCHLENS_PROTOCOL_VERSION,
      messageId: createId('message'),
      channelId,
      projectId,
      type: 'studio:clear-selection',
      payload: { selectionId: selection?.id },
    };
    iframeRef.current?.contentWindow?.postMessage(message, previewOrigin);
    if (selection) {
      contextBySelectionRef.current.delete(selection.id);
      contextGenerationBySelectionRef.current.delete(selection.id);
    }
    activeSelectionIdRef.current = undefined;
    setContextSelectionId(undefined);
    setSelection(undefined);
    if (activeDaemonClient) {
      void activeDaemonClient.clearSelection(projectId).catch(() => setDaemonStatus('failed'));
    }
  }

  async function sendChat(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const activeSelection = selection;
    const instruction = chatDraft.trim();
    if (!activeSelection || !instruction) {
      return;
    }
    const selectionContext = contextBySelectionRef.current.get(activeSelection.id);
    if (!selectionContext || contextSelectionId !== activeSelection.id) {
      return;
    }

    setChatDraft('');
    updateThread(activeSelection.id, (thread) => ({
      ...thread,
      status: 'running',
      messages: [...thread.messages, { id: createId('chat'), role: 'user', content: instruction }],
    }));

    try {
      if (activeDaemonClient) {
        await activeDaemonClient.setSelection(projectId, selectionContext);
      } else if (configuredProvider !== 'mock') {
        throw new Error(`${configuredProvider} requires PatchLens daemon`);
      }

      const session =
        sessionRef.current ??
        (activeDaemonClient
          ? await activeDaemonClient.createSession(projectId, configuredProvider)
          : await provider.createSession({ projectId }));
      sessionRef.current = session;
      const request = createAgentRequest(
        activeSelection,
        instruction,
        session.id,
        selectionContext,
      );

      const events = activeDaemonClient
        ? activeDaemonClient.streamRequest(request)
        : provider.sendMessage(session, request);
      for await (const agentEvent of events) {
        if (agentEvent.type === 'session') {
          sessionRef.current = agentEvent.payload.session;
        }
        applyAgentEvent(activeSelection.id, agentEvent);
        if (agentEvent.type === 'verification' && activeDaemonClient) {
          await loadVerificationImages(activeSelection.id, agentEvent);
        }
      }
    } catch (error) {
      updateThread(activeSelection.id, (thread) => ({
        ...thread,
        status: 'failed',
        messages: [
          ...thread.messages,
          {
            id: createId('chat'),
            role: 'status',
            content: error instanceof Error ? error.message : 'Provider failed',
          },
        ],
      }));
    }
  }

  async function cancelChat(): Promise<void> {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    try {
      if (activeDaemonClient) {
        await activeDaemonClient.cancelSession(session.id);
      } else {
        await provider.cancel(session);
      }
    } catch {
      setDaemonStatus('failed');
    }
  }

  async function loadVerificationImages(
    selectionId: string,
    event: Extract<AgentEvent, { type: 'verification' }>,
  ): Promise<void> {
    if (!activeDaemonClient) {
      return;
    }
    const load = async (
      screenshot: ScreenshotReference | undefined,
    ): Promise<string | undefined> => {
      if (!screenshot) {
        return undefined;
      }
      try {
        const blob = await activeDaemonClient.loadCapture(projectId, screenshot);
        const url = URL.createObjectURL(blob);
        captureUrlsRef.current.add(url);
        return url;
      } catch {
        return undefined;
      }
    };
    const [beforeImageUrl, afterImageUrl] = await Promise.all([
      load(event.payload.beforeScreenshot),
      load(event.payload.afterScreenshot),
    ]);
    replaceCaptureUrls(selectionId, beforeImageUrl, afterImageUrl);
    updateThread(selectionId, (thread) => ({
      ...thread,
      verification: thread.verification
        ? {
            ...thread.verification,
            ...(beforeImageUrl ? { beforeImageUrl } : {}),
            ...(afterImageUrl ? { afterImageUrl } : {}),
          }
        : undefined,
    }));
  }

  function replaceCaptureUrls(
    selectionId: string,
    beforeImageUrl: string | undefined,
    afterImageUrl: string | undefined,
  ): void {
    const previous = captureUrlsBySelectionRef.current.get(selectionId);
    for (const url of [previous?.before, previous?.after]) {
      if (url) {
        URL.revokeObjectURL(url);
        captureUrlsRef.current.delete(url);
      }
    }
    if (beforeImageUrl || afterImageUrl) {
      captureUrlsBySelectionRef.current.set(selectionId, {
        ...(beforeImageUrl ? { before: beforeImageUrl } : {}),
        ...(afterImageUrl ? { after: afterImageUrl } : {}),
      });
    } else {
      captureUrlsBySelectionRef.current.delete(selectionId);
    }
  }

  async function persistInspectorContext(
    inspectorContext: InspectorSelectionContext,
    generation: number,
  ): Promise<void> {
    const selectionId = inspectorContext.selection.id;
    const isCurrent = () =>
      activeSelectionIdRef.current === selectionId &&
      contextGenerationBySelectionRef.current.get(selectionId) === generation;
    if (!isCurrent()) {
      return;
    }
    const baseContext = createSelectionContextFromInspector(inspectorContext);
    let screenshot: SelectionContext['screenshot'] =
      contextBySelectionRef.current.get(selectionId)?.screenshot;
    if (activeDaemonClient) {
      await activeDaemonClient.setSelection(projectId, baseContext);
      if (!isCurrent()) {
        return;
      }
      if (inspectorContext.screenshot) {
        screenshot = await activeDaemonClient.saveCapture(
          projectId,
          selectionId,
          inspectorContext.screenshot,
        );
        if (!isCurrent()) {
          return;
        }
      }
    }
    const context: SelectionContext = {
      ...baseContext,
      ...(screenshot ? { screenshot } : {}),
    };
    if (!isCurrent()) {
      return;
    }
    contextBySelectionRef.current.set(selectionId, context);
    if (activeDaemonClient) {
      await activeDaemonClient.setSelection(projectId, context);
      if (!isCurrent()) {
        return;
      }
    }
    setContextSelectionId(selectionId);
  }

  function applyAgentEvent(selectionId: string, event: AgentEvent): void {
    updateThread(selectionId, (thread) => {
      if (event.type === 'status') {
        return {
          ...thread,
          status: 'running',
          messages: [
            ...thread.messages,
            { id: createId('chat'), role: 'status', content: event.payload.message },
          ],
        };
      }

      if (event.type === 'message') {
        return {
          ...thread,
          messages: [
            ...thread.messages,
            { id: createId('chat'), role: 'assistant', content: event.payload.content },
          ],
        };
      }

      if (event.type === 'files') {
        return { ...thread, files: event.payload.files };
      }

      if (event.type === 'diff') {
        return {
          ...thread,
          diff: {
            transactionId: event.payload.transactionId,
            content: event.payload.diff,
          },
        };
      }

      if (event.type === 'verification') {
        return {
          ...thread,
          verification: {
            ok: event.payload.ok,
            summary: event.payload.summary,
            commands: event.payload.commands,
            ...(event.payload.beforeScreenshot
              ? { beforeScreenshot: event.payload.beforeScreenshot }
              : {}),
            ...(event.payload.afterScreenshot
              ? { afterScreenshot: event.payload.afterScreenshot }
              : {}),
            ...(event.payload.visualComparison
              ? { visualComparison: event.payload.visualComparison }
              : {}),
          },
        };
      }

      if (event.type === 'complete') {
        return {
          ...thread,
          status: thread.verification?.ok === false ? 'failed' : 'complete',
        };
      }

      if (event.type === 'error' || event.type === 'cancelled') {
        return {
          ...thread,
          status: 'failed',
          messages: [
            ...thread.messages,
            {
              id: createId('chat'),
              role: 'status',
              content:
                event.type === 'error'
                  ? event.payload.message
                  : (event.payload.reason ?? 'Request cancelled'),
            },
          ],
        };
      }

      return thread;
    });
  }

  function updateThread(selectionId: string, update: (thread: ChatThread) => ChatThread): void {
    setThreads((current) => ({
      ...current,
      [selectionId]: update(current[selectionId] ?? emptyThread),
    }));
  }

  const primaryElement = selection?.elements.find(
    (element) => element.id === selection.primaryElementId,
  );
  const primarySource = selection?.sourceCandidates[0]?.location ?? primaryElement?.source;
  const activeThread = selection ? (threads[selection.id] ?? emptyThread) : emptyThread;

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div>
          <p className="eyebrow">Visual context layer</p>
          <h1>PatchLens Studio</h1>
        </div>
        <div className="status-group">
          <span className={ready ? 'status status-ready' : 'status'}>
            {ready ? 'Preview connected' : 'Waiting for preview'}
          </span>
          <span className={daemonStatus === 'ready' ? 'status status-ready' : 'status'}>
            Daemon {daemonStatus}
          </span>
        </div>
      </header>

      <form className="toolbar" onSubmit={connectPreview}>
        <label>
          Preview URL
          <input
            value={previewDraft}
            onChange={(event) => setPreviewDraft(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button type="submit">Connect</button>
        <button
          className={enabled ? 'button-active' : ''}
          type="button"
          disabled={!ready}
          onClick={toggleInspector}
        >
          {enabled ? 'Stop selecting' : 'Select UI'}
        </button>
        <button type="button" disabled={!selection} onClick={clearSelection}>
          Clear
        </button>
      </form>

      <section className="workspace">
        <aside className="context-panel">
          <div className="panel-heading">
            <span>Active selection</span>
            {selection ? <strong>{selection.confidence}</strong> : null}
          </div>

          {selection ? (
            <div className="selection-details">
              <Detail label="Component" value={primarySource?.componentName ?? 'Unknown'} />
              <Detail label="File" value={primarySource?.file ?? 'Visual context only'} />
              <Detail
                label="Location"
                value={
                  primarySource ? `${primarySource.line}:${primarySource.column}` : 'Not mapped'
                }
              />
              <Detail label="Element" value={primaryElement?.tagName ?? 'Unknown'} />
              <Detail label="Route" value={selection.route} />
              <div>
                <span className="detail-label">Sanitized HTML</span>
                <pre>{primaryElement?.sanitizedHtml}</pre>
              </div>
            </div>
          ) : (
            <p className="empty-state">Enable selection, then click an element inside preview.</p>
          )}
        </aside>

        <div className="preview-frame">
          {previewUrl ? (
            <iframe ref={iframeRef} title="PatchLens preview" src={previewUrl} />
          ) : (
            <p className="preview-error">
              {daemonClient && daemonStatus === 'connecting'
                ? 'Waiting for daemon project registration.'
                : 'Preview URL is invalid.'}
            </p>
          )}
          {selection ? (
            <AnchoredChat
              selection={selection}
              thread={activeThread}
              draft={chatDraft}
              contextReady={contextSelectionId === selection.id}
              provider={configuredProvider}
              onDraftChange={setChatDraft}
              onSubmit={sendChat}
              onCancel={cancelChat}
            />
          ) : null}
        </div>
      </section>
    </main>
  );
}

function AnchoredChat({
  selection,
  thread,
  draft,
  contextReady,
  provider,
  onDraftChange,
  onSubmit,
  onCancel,
}: {
  selection: VisualSelection;
  thread: ChatThread;
  draft: string;
  contextReady: boolean;
  provider: ProviderId;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  return (
    <section className="anchored-chat" style={getChatPosition(selection)}>
      <header>
        <div>
          <strong>Selection chat</strong>
          <span>{selection.confidence}</span>
        </div>
        <small>{thread.status}</small>
      </header>

      <div className="chat-messages">
        {thread.messages.length > 0 ? (
          thread.messages.map((message) => (
            <p className={`chat-message chat-${message.role}`} key={message.id}>
              {message.content}
            </p>
          ))
        ) : (
          <p className="chat-placeholder">Describe change for selected component.</p>
        )}
      </div>

      {thread.files.length > 0 ? (
        <p className="chat-files">Files: {thread.files.join(', ')}</p>
      ) : null}

      {thread.verification ? (
        <p
          className={
            thread.verification.ok
              ? 'chat-verification verification-ok'
              : 'chat-verification verification-failed'
          }
        >
          {thread.verification.summary}
          {thread.verification.commands.length > 0
            ? ` (${thread.verification.commands.join(', ')})`
            : ''}
          {thread.verification.visualComparison
            ? ` · ${(thread.verification.visualComparison.similarity * 100).toFixed(1)}% similar`
            : ''}
        </p>
      ) : null}

      {thread.verification?.beforeImageUrl || thread.verification?.afterImageUrl ? (
        <div className="chat-captures">
          {thread.verification.beforeImageUrl ? (
            <figure>
              <img src={thread.verification.beforeImageUrl} alt="Before change" />
              <figcaption>Before</figcaption>
            </figure>
          ) : null}
          {thread.verification.afterImageUrl ? (
            <figure>
              <img src={thread.verification.afterImageUrl} alt="After change" />
              <figcaption>After</figcaption>
            </figure>
          ) : null}
        </div>
      ) : null}

      {thread.diff ? (
        <details className="chat-diff">
          <summary>Diff {thread.diff.transactionId}</summary>
          <pre>{thread.diff.content}</pre>
        </details>
      ) : null}

      <form onSubmit={onSubmit}>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Make this CTA more prominent..."
          rows={3}
        />
        <button
          type="submit"
          disabled={!draft.trim() || thread.status === 'running' || !contextReady}
        >
          {thread.status === 'running'
            ? 'Running...'
            : contextReady
              ? `Send to ${provider}`
              : 'Capturing context...'}
        </button>
        {thread.status === 'running' ? (
          <button type="button" onClick={() => void onCancel()}>
            Cancel
          </button>
        ) : null}
      </form>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="detail-label">{label}</span>
      <strong className="detail-value">{value}</strong>
    </div>
  );
}

function createAgentRequest(
  selection: VisualSelection,
  instruction: string,
  sessionId: string,
  context: SelectionContext,
): AgentRequest {
  const createdAt = new Date().toISOString();

  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    requestId: createId('request'),
    projectId: selection.projectId,
    sessionId,
    selectionId: selection.id,
    provider: configuredProvider,
    instruction,
    context,
    scopePolicy: 'prefer-selection',
    verification: {
      route: selection.route,
      captureAfterChange: true,
      commands: [],
    },
    createdAt,
  };
}

function createSelectionContextFromInspector(context: InspectorSelectionContext): SelectionContext {
  return {
    schemaVersion: context.schemaVersion,
    selection: context.selection,
    sanitizedHtml: context.sanitizedHtml,
    computedStyles: context.computedStyles,
    ...(context.designTokens ? { designTokens: context.designTokens } : {}),
    ...(context.accessibilitySummary ? { accessibilitySummary: context.accessibilitySummary } : {}),
    relatedSourceFiles: context.relatedSourceFiles,
    consoleEntries: context.consoleEntries,
    capturedAt: context.capturedAt,
  };
}

function createSelectionContext(
  selection: VisualSelection,
  capturedAt = new Date().toISOString(),
): SelectionContext {
  const relatedSourceFiles = [
    ...new Map(
      selection.sourceCandidates.map((candidate) => [
        candidate.location.file,
        {
          path: candidate.location.file,
          startLine: Math.max(1, candidate.location.line - 12),
          endLine: candidate.location.line + 24,
        },
      ]),
    ).values(),
  ];
  return {
    schemaVersion: PATCHLENS_PROTOCOL_VERSION,
    selection,
    sanitizedHtml: selection.elements
      .map((element) => element.sanitizedHtml)
      .join('\n')
      .slice(0, PATCHLENS_PROTOCOL_LIMITS.htmlLength),
    computedStyles: {},
    relatedSourceFiles,
    consoleEntries: [],
    capturedAt,
  };
}

function getChatPosition(selection: VisualSelection): CSSProperties {
  const width = 350;
  const height = 330;
  const left = Math.min(
    Math.max(12, selection.rectangle.x),
    Math.max(12, selection.viewport.width - width - 12),
  );
  const below = selection.rectangle.y + selection.rectangle.height + 12;
  const top =
    below + height <= selection.viewport.height
      ? below
      : Math.max(12, selection.rectangle.y - height - 12);

  return {
    left,
    top,
    width,
  };
}

function buildPreviewUrl(baseUrl: string, activeProjectId: string, channelId: string) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('patchlensProjectId', activeProjectId);
    url.searchParams.set('patchlensChannelId', channelId);
    url.searchParams.set('patchlensStudioOrigin', location.origin);
    return url.toString();
  } catch {
    return undefined;
  }
}

function getOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function readRuntimeConfig(): StudioRuntimeConfig {
  const element = document.getElementById('patchlens-runtime-config');
  if (!element?.textContent) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(element.textContent);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as StudioRuntimeConfig)
      : {};
  } catch {
    return {};
  }
}
