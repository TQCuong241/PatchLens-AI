import {
  PATCHLENS_MESSAGE_SOURCE,
  PATCHLENS_PROTOCOL_LIMITS,
  PATCHLENS_PROTOCOL_VERSION,
} from './constants.js';
import type { AgentEvent, AgentRequest, AgentSession, DaemonHealth } from './agent.js';
import type { InspectorToStudioMessage, StudioToInspectorMessage } from './messages.js';
import type {
  ConsoleEntry,
  InlineScreenshot,
  InspectorSelectionContext,
  Rectangle,
  ScreenshotReference,
  SelectedElement,
  SelectionContext,
  SourceCandidate,
  SourceFileRange,
  SourceLocation,
  Viewport,
  VisualSelection,
} from './selection.js';

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult<Value> =
  { success: true; data: Value } | { success: false; issues: ValidationIssue[] };

type UnknownRecord = Record<string, unknown>;

type ProtocolEnvelopeRecord = UnknownRecord & {
  payload: UnknownRecord;
  projectId: string;
  type: string;
};

const validFrameworks = new Set(['react', 'next', 'unknown']);
const validRenderBoundaries = new Set(['client', 'server', 'shared']);
const validConfidence = new Set(['exact', 'likely', 'visual-only']);
const validConsoleLevels = new Set(['warning', 'error']);
const validMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const validScopePolicies = new Set(['prefer-selection', 'strict', 'allow-related']);
const validVerificationCommands = new Set(['typecheck', 'lint', 'test', 'build']);
const validSessionStatuses = new Set(['idle', 'running', 'waiting', 'failed', 'disposed']);
const validRequestStatuses = new Set([
  'queued',
  'running',
  'waiting',
  'completed',
  'cancelled',
  'failed',
]);
const validProviderStatuses = new Set(['available', 'planned', 'unavailable']);

function success<Value>(data: Value): ValidationResult<Value> {
  return { success: true, data };
}

function failure(path: string, message: string): ValidationResult<never> {
  return { success: false, issues: [{ path, message }] };
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isOptionalBoundedString(value: unknown, maximumLength: number): boolean {
  return value === undefined || isBoundedString(value, maximumLength);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  const parsed = new Date(timestamp);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6]) &&
    parsed.getUTCMilliseconds() === milliseconds
  );
}

function isProjectRelativePath(value: unknown): value is string {
  if (!isBoundedString(value, PATCHLENS_PROTOCOL_LIMITS.textLength)) {
    return false;
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isStringRecord(
  value: unknown,
  maximumEntries = PATCHLENS_PROTOCOL_LIMITS.computedStyles,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= maximumEntries &&
    Object.entries(value).every(
      ([key, item]) =>
        isBoundedString(key, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
        typeof item === 'string' &&
        item.length <= PATCHLENS_PROTOCOL_LIMITS.textLength,
    )
  );
}

export function isRectangle(value: unknown): value is Rectangle {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    value.width >= 0 &&
    isFiniteNumber(value.height) &&
    value.height >= 0
  );
}

export function isViewport(value: unknown): value is Viewport {
  return (
    isRecord(value) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    isFiniteNumber(value.deviceScaleFactor) &&
    value.deviceScaleFactor > 0
  );
}

export function isSourceLocation(value: unknown): value is SourceLocation {
  return (
    isRecord(value) &&
    isBoundedString(value.id, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    typeof value.framework === 'string' &&
    validFrameworks.has(value.framework) &&
    (value.renderBoundary === undefined ||
      (typeof value.renderBoundary === 'string' &&
        validRenderBoundaries.has(value.renderBoundary))) &&
    isOptionalBoundedString(value.componentName, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isProjectRelativePath(value.file) &&
    isPositiveInteger(value.line) &&
    isNonNegativeInteger(value.column) &&
    isOptionalBoundedString(value.tagName, PATCHLENS_PROTOCOL_LIMITS.identifierLength)
  );
}

function isSourceCandidate(value: unknown): value is SourceCandidate {
  return (
    isRecord(value) &&
    isSourceLocation(value.location) &&
    isFiniteNumber(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

function isSelectedElement(value: unknown): value is SelectedElement {
  return (
    isRecord(value) &&
    isBoundedString(value.id, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isOptionalBoundedString(value.patchlensId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.tagName, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    typeof value.text === 'string' &&
    value.text.length <= PATCHLENS_PROTOCOL_LIMITS.textLength &&
    typeof value.sanitizedHtml === 'string' &&
    value.sanitizedHtml.length <= PATCHLENS_PROTOCOL_LIMITS.htmlLength &&
    isRectangle(value.rectangle) &&
    (value.source === undefined || isSourceLocation(value.source))
  );
}

export function isVisualSelection(value: unknown): value is VisualSelection {
  if (!isRecord(value) || value.schemaVersion !== PATCHLENS_PROTOCOL_VERSION) {
    return false;
  }

  if (!Array.isArray(value.elements) || value.elements.length === 0) {
    return false;
  }

  return (
    value.elements.length <= PATCHLENS_PROTOCOL_LIMITS.elements &&
    value.elements.every(isSelectedElement) &&
    isBoundedString(value.id, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.projectId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.route, PATCHLENS_PROTOCOL_LIMITS.routeLength) &&
    isViewport(value.viewport) &&
    isRectangle(value.rectangle) &&
    isBoundedString(value.primaryElementId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    value.elements.some((element) => element.id === value.primaryElementId) &&
    Array.isArray(value.sourceCandidates) &&
    value.sourceCandidates.length <= PATCHLENS_PROTOCOL_LIMITS.sourceCandidates &&
    value.sourceCandidates.every(isSourceCandidate) &&
    typeof value.confidence === 'string' &&
    validConfidence.has(value.confidence) &&
    isIsoTimestamp(value.createdAt)
  );
}

function isSourceFileRange(value: unknown): value is SourceFileRange {
  return (
    isRecord(value) &&
    isProjectRelativePath(value.path) &&
    isPositiveInteger(value.startLine) &&
    isPositiveInteger(value.endLine) &&
    value.endLine >= value.startLine
  );
}

function isConsoleEntry(value: unknown): value is ConsoleEntry {
  return (
    isRecord(value) &&
    typeof value.level === 'string' &&
    validConsoleLevels.has(value.level) &&
    typeof value.message === 'string' &&
    value.message.length <= PATCHLENS_PROTOCOL_LIMITS.textLength &&
    isIsoTimestamp(value.createdAt)
  );
}

export function isScreenshotReference(value: unknown): value is ScreenshotReference {
  return (
    isRecord(value) &&
    isProjectRelativePath(value.path) &&
    typeof value.mimeType === 'string' &&
    validMimeTypes.has(value.mimeType) &&
    isPositiveInteger(value.width) &&
    isPositiveInteger(value.height) &&
    isNonNegativeInteger(value.byteLength) &&
    value.byteLength <= PATCHLENS_PROTOCOL_LIMITS.screenshotBytes &&
    isOptionalPerceptualHash(value.perceptualHash)
  );
}

export function isInlineScreenshot(value: unknown): value is InlineScreenshot {
  if (
    !isRecord(value) ||
    typeof value.mimeType !== 'string' ||
    !validMimeTypes.has(value.mimeType) ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    value.width > 4_096 ||
    value.height > 4_096 ||
    !isNonNegativeInteger(value.byteLength) ||
    value.byteLength > PATCHLENS_PROTOCOL_LIMITS.screenshotBytes ||
    !isOptionalPerceptualHash(value.perceptualHash) ||
    typeof value.dataUrl !== 'string' ||
    value.dataUrl.length > PATCHLENS_PROTOCOL_LIMITS.screenshotDataUrlLength
  ) {
    return false;
  }
  return value.dataUrl.startsWith(`data:${value.mimeType};base64,`);
}

export function isInspectorSelectionContext(value: unknown): value is InspectorSelectionContext {
  return (
    isRecord(value) &&
    value.schemaVersion === PATCHLENS_PROTOCOL_VERSION &&
    isVisualSelection(value.selection) &&
    (value.screenshot === undefined || isInlineScreenshot(value.screenshot)) &&
    typeof value.sanitizedHtml === 'string' &&
    value.sanitizedHtml.length <= PATCHLENS_PROTOCOL_LIMITS.htmlLength &&
    isStringRecord(value.computedStyles) &&
    (value.designTokens === undefined || isStringRecord(value.designTokens)) &&
    isOptionalBoundedString(value.accessibilitySummary, PATCHLENS_PROTOCOL_LIMITS.textLength) &&
    Array.isArray(value.relatedSourceFiles) &&
    value.relatedSourceFiles.length <= PATCHLENS_PROTOCOL_LIMITS.relatedSourceFiles &&
    value.relatedSourceFiles.every(isSourceFileRange) &&
    Array.isArray(value.consoleEntries) &&
    value.consoleEntries.length <= PATCHLENS_PROTOCOL_LIMITS.consoleEntries &&
    value.consoleEntries.every(isConsoleEntry) &&
    isIsoTimestamp(value.capturedAt)
  );
}

export function isSelectionContext(value: unknown): value is SelectionContext {
  return (
    isRecord(value) &&
    value.schemaVersion === PATCHLENS_PROTOCOL_VERSION &&
    isVisualSelection(value.selection) &&
    (value.screenshot === undefined || isScreenshotReference(value.screenshot)) &&
    typeof value.sanitizedHtml === 'string' &&
    value.sanitizedHtml.length <= PATCHLENS_PROTOCOL_LIMITS.htmlLength &&
    isStringRecord(value.computedStyles) &&
    (value.designTokens === undefined || isStringRecord(value.designTokens)) &&
    isOptionalBoundedString(value.accessibilitySummary, PATCHLENS_PROTOCOL_LIMITS.textLength) &&
    Array.isArray(value.relatedSourceFiles) &&
    value.relatedSourceFiles.length <= PATCHLENS_PROTOCOL_LIMITS.relatedSourceFiles &&
    value.relatedSourceFiles.every(isSourceFileRange) &&
    Array.isArray(value.consoleEntries) &&
    value.consoleEntries.length <= PATCHLENS_PROTOCOL_LIMITS.consoleEntries &&
    value.consoleEntries.every(isConsoleEntry) &&
    isIsoTimestamp(value.capturedAt)
  );
}

function isOptionalPerceptualHash(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && /^[a-f0-9]{16}$/.test(value));
}

function isMessageEnvelope(value: unknown): value is ProtocolEnvelopeRecord {
  return (
    isRecord(value) &&
    value.source === PATCHLENS_MESSAGE_SOURCE &&
    value.schemaVersion === PATCHLENS_PROTOCOL_VERSION &&
    isBoundedString(value.messageId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.channelId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.projectId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    typeof value.type === 'string' &&
    isRecord(value.payload)
  );
}

function isReadyPayload(value: UnknownRecord): boolean {
  return (
    isBoundedString(value.route, PATCHLENS_PROTOCOL_LIMITS.routeLength) &&
    isViewport(value.viewport)
  );
}

function isSelectionClearedPayload(value: UnknownRecord): boolean {
  return isOptionalBoundedString(value.selectionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength);
}

export function parseInspectorMessage(value: unknown): ValidationResult<InspectorToStudioMessage> {
  if (!isMessageEnvelope(value)) {
    return failure('$', 'Invalid PatchLens message envelope');
  }

  if (value.type === 'inspector:ready' && isReadyPayload(value.payload)) {
    return success(value as InspectorToStudioMessage);
  }

  if (
    value.type === 'inspector:selection' &&
    isVisualSelection(value.payload) &&
    value.payload.projectId === value.projectId
  ) {
    return success(value as InspectorToStudioMessage);
  }

  if (
    value.type === 'inspector:context' &&
    isInspectorSelectionContext(value.payload) &&
    value.payload.selection.projectId === value.projectId
  ) {
    return success(value as InspectorToStudioMessage);
  }

  if (value.type === 'inspector:selection-cleared' && isSelectionClearedPayload(value.payload)) {
    return success(value as InspectorToStudioMessage);
  }

  return failure('$.type', 'Unknown Inspector message or invalid payload');
}

export function isInspectorMessage(value: unknown): value is InspectorToStudioMessage {
  return parseInspectorMessage(value).success;
}

export function parseStudioMessage(value: unknown): ValidationResult<StudioToInspectorMessage> {
  if (!isMessageEnvelope(value)) {
    return failure('$', 'Invalid PatchLens message envelope');
  }

  if (value.type === 'studio:set-inspector-mode' && typeof value.payload.enabled === 'boolean') {
    return success(value as StudioToInspectorMessage);
  }

  if (value.type === 'studio:clear-selection' && isSelectionClearedPayload(value.payload)) {
    return success(value as StudioToInspectorMessage);
  }

  return failure('$.type', 'Unknown Studio message or invalid payload');
}

export function isStudioMessage(value: unknown): value is StudioToInspectorMessage {
  return parseStudioMessage(value).success;
}

export function parseAgentRequest(value: unknown): ValidationResult<AgentRequest> {
  if (!isRecord(value) || value.schemaVersion !== PATCHLENS_PROTOCOL_VERSION) {
    return failure('$', 'Invalid Agent request envelope');
  }

  const validRequest =
    isBoundedString(value.requestId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.projectId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isOptionalBoundedString(value.sessionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.selectionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.provider, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.instruction, PATCHLENS_PROTOCOL_LIMITS.instructionLength) &&
    isSelectionContext(value.context) &&
    value.context.selection.id === value.selectionId &&
    value.context.selection.projectId === value.projectId &&
    typeof value.scopePolicy === 'string' &&
    validScopePolicies.has(value.scopePolicy) &&
    isVerificationRequest(value.verification) &&
    isIsoTimestamp(value.createdAt);

  return validRequest
    ? success(value as AgentRequest)
    : failure('$', 'Invalid Agent request payload');
}

function isVerificationRequest(value: unknown): boolean {
  return (
    isRecord(value) &&
    isBoundedString(value.route, PATCHLENS_PROTOCOL_LIMITS.routeLength) &&
    typeof value.captureAfterChange === 'boolean' &&
    isVerificationCommandArray(value.commands)
  );
}

export function isAgentSession(value: unknown): value is AgentSession {
  return (
    isRecord(value) &&
    value.schemaVersion === PATCHLENS_PROTOCOL_VERSION &&
    isBoundedString(value.id, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.projectId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.provider, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isOptionalBoundedString(value.providerSessionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    typeof value.status === 'string' &&
    validSessionStatuses.has(value.status) &&
    isOptionalBoundedString(value.activeSelectionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt)
  );
}

export function parseAgentEvent(value: unknown): ValidationResult<AgentEvent> {
  if (!isAgentEventEnvelope(value)) {
    return failure('$', 'Invalid Agent event envelope');
  }

  if (value.type === 'session' && isAgentSession(value.payload.session)) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'status' &&
    typeof value.payload.status === 'string' &&
    validRequestStatuses.has(value.payload.status) &&
    isBoundedString(value.payload.message, PATCHLENS_PROTOCOL_LIMITS.textLength)
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'message' &&
    value.payload.role === 'assistant' &&
    isBoundedString(value.payload.content, PATCHLENS_PROTOCOL_LIMITS.textLength)
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'files' &&
    Array.isArray(value.payload.files) &&
    value.payload.files.length <= PATCHLENS_PROTOCOL_LIMITS.files &&
    value.payload.files.every(isProjectRelativePath)
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'diff' &&
    isBoundedString(value.payload.transactionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    typeof value.payload.diff === 'string' &&
    value.payload.diff.length <= PATCHLENS_PROTOCOL_LIMITS.diffLength
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'verification' &&
    typeof value.payload.ok === 'boolean' &&
    isBoundedString(value.payload.summary, PATCHLENS_PROTOCOL_LIMITS.textLength) &&
    isVerificationCommandArray(value.payload.commands) &&
    (value.payload.beforeScreenshot === undefined ||
      isScreenshotReference(value.payload.beforeScreenshot)) &&
    (value.payload.afterScreenshot === undefined ||
      isScreenshotReference(value.payload.afterScreenshot)) &&
    (value.payload.visualComparison === undefined ||
      isVisualComparison(value.payload.visualComparison))
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'error' &&
    isBoundedString(value.payload.code, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.payload.message, PATCHLENS_PROTOCOL_LIMITS.textLength) &&
    typeof value.payload.retryable === 'boolean'
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'cancelled' &&
    isOptionalBoundedString(value.payload.reason, PATCHLENS_PROTOCOL_LIMITS.textLength)
  ) {
    return success(value as AgentEvent);
  }

  if (
    value.type === 'complete' &&
    isOptionalBoundedString(
      value.payload.transactionId,
      PATCHLENS_PROTOCOL_LIMITS.identifierLength,
    ) &&
    isBoundedString(value.payload.summary, PATCHLENS_PROTOCOL_LIMITS.textLength)
  ) {
    return success(value as AgentEvent);
  }

  return failure('$.type', 'Unknown Agent event or invalid payload');
}

function isVisualComparison(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.hammingDistance) &&
    value.hammingDistance <= 64 &&
    isFiniteNumber(value.similarity) &&
    value.similarity >= 0 &&
    value.similarity <= 1 &&
    typeof value.changed === 'boolean'
  );
}

function isVerificationCommandArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= PATCHLENS_PROTOCOL_LIMITS.commands &&
    value.every((command) => typeof command === 'string' && validVerificationCommands.has(command))
  );
}

export function parseDaemonHealth(value: unknown): ValidationResult<DaemonHealth> {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.service !== 'patchlens-daemon' ||
    value.protocolVersion !== PATCHLENS_PROTOCOL_VERSION ||
    !isBoundedString(value.version, PATCHLENS_PROTOCOL_LIMITS.identifierLength) ||
    !Array.isArray(value.providers)
  ) {
    return failure('$', 'Invalid daemon health payload');
  }

  const providersAreValid = value.providers.every(
    (provider) =>
      isRecord(provider) &&
      isBoundedString(provider.id, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
      typeof provider.status === 'string' &&
      validProviderStatuses.has(provider.status),
  );
  return providersAreValid
    ? success(value as DaemonHealth)
    : failure('$.providers', 'Invalid daemon provider status');
}

function isAgentEventEnvelope(value: unknown): value is UnknownRecord & {
  type: string;
  payload: UnknownRecord;
} {
  return (
    isRecord(value) &&
    value.schemaVersion === PATCHLENS_PROTOCOL_VERSION &&
    typeof value.type === 'string' &&
    isBoundedString(value.requestId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isBoundedString(value.sessionId, PATCHLENS_PROTOCOL_LIMITS.identifierLength) &&
    isNonNegativeInteger(value.sequence) &&
    isIsoTimestamp(value.createdAt) &&
    isRecord(value.payload)
  );
}
