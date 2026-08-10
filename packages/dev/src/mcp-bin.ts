#!/usr/bin/env node

import { resolve } from 'node:path';

import { startPatchLensMcpServer } from '@patchlens-ai/mcp-server';

const sessionPath = readSessionPath(process.argv.slice(2));
try {
  await startPatchLensMcpServer({ sessionPath });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PatchLens MCP server failed');
  process.exitCode = 1;
}

function readSessionPath(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length !== 2 || args[0] !== '--session' || !args[1]) {
    throw new Error('Usage: patchlens-mcp [--session PATH]');
  }
  return resolve(args[1]);
}
