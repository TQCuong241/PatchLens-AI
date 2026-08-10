import type { PATCHLENS_PROTOCOL_VERSION } from './constants.js';

export type ProtocolVersion = typeof PATCHLENS_PROTOCOL_VERSION;

export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
};

export type SourceLocation = {
  id: string;
  framework: 'react' | 'next' | 'unknown';
  renderBoundary?: 'client' | 'server' | 'shared';
  componentName?: string;
  file: string;
  line: number;
  column: number;
  tagName?: string;
};

export type SourceManifestEntry = SourceLocation;

export type SourceManifest = Record<string, SourceManifestEntry>;

export type SourceCandidate = {
  location: SourceLocation;
  confidence: number;
};

export type SelectionConfidence = 'exact' | 'likely' | 'visual-only';

export type SelectedElement = {
  id: string;
  patchlensId?: string;
  tagName: string;
  text: string;
  sanitizedHtml: string;
  rectangle: Rectangle;
  source?: SourceLocation;
};

export type VisualSelection = {
  schemaVersion: ProtocolVersion;
  id: string;
  projectId: string;
  route: string;
  viewport: Viewport;
  rectangle: Rectangle;
  elements: SelectedElement[];
  primaryElementId: string;
  sourceCandidates: SourceCandidate[];
  confidence: SelectionConfidence;
  createdAt: string;
};

export type SourceFileRange = {
  path: string;
  startLine: number;
  endLine: number;
};

export type ConsoleEntry = {
  level: 'warning' | 'error';
  message: string;
  createdAt: string;
};

export type ScreenshotReference = {
  path: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  byteLength: number;
  perceptualHash?: string;
};

export type InlineScreenshot = Omit<ScreenshotReference, 'path'> & {
  dataUrl: string;
};

export type InspectorSelectionContext = {
  schemaVersion: ProtocolVersion;
  selection: VisualSelection;
  screenshot?: InlineScreenshot;
  sanitizedHtml: string;
  computedStyles: Record<string, string>;
  designTokens?: Record<string, string>;
  accessibilitySummary?: string;
  relatedSourceFiles: SourceFileRange[];
  consoleEntries: ConsoleEntry[];
  capturedAt: string;
};

export type SelectionContext = {
  schemaVersion: ProtocolVersion;
  selection: VisualSelection;
  screenshot?: ScreenshotReference;
  sanitizedHtml: string;
  computedStyles: Record<string, string>;
  designTokens?: Record<string, string>;
  accessibilitySummary?: string;
  relatedSourceFiles: SourceFileRange[];
  consoleEntries: ConsoleEntry[];
  capturedAt: string;
};
