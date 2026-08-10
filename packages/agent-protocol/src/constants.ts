export const PATCHLENS_MESSAGE_SOURCE = 'patchlens-ai' as const;

export const PATCHLENS_PROTOCOL_VERSION = 1 as const;

export const PATCHLENS_PROTOCOL_LIMITS = {
  identifierLength: 128,
  routeLength: 2_048,
  textLength: 20_000,
  htmlLength: 200_000,
  instructionLength: 20_000,
  diffLength: 500_000,
  elements: 500,
  sourceCandidates: 100,
  relatedSourceFiles: 100,
  consoleEntries: 100,
  computedStyles: 100,
  screenshotBytes: 2_000_000,
  screenshotDataUrlLength: 2_700_000,
  commands: 20,
  files: 500,
} as const;
