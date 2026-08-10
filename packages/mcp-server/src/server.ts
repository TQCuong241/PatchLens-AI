import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import type { VerificationCommandId } from '@patchlens-ai/agent-protocol';

import { PatchLensContextService } from './service.js';
import { discoverPatchLensSession, loadPatchLensSession } from './session.js';

export type StartPatchLensMcpServerOptions = {
  cwd?: string;
  sessionPath?: string;
};

const verificationCommandSchema = z.enum(['typecheck', 'lint', 'test', 'build']);

export function createPatchLensMcpServer(service: PatchLensContextService): McpServer {
  const server = new McpServer({ name: 'patchlens-ai', version: '0.1.0' });

  server.registerResource(
    'active-selection',
    'patchlens://active-selection',
    {
      title: 'PatchLens active selection',
      description: 'Current visual selection bound to this project session.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await service.getActiveSelection(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'selection-context',
    'patchlens://selection-context',
    {
      title: 'PatchLens selection context',
      description: 'Sanitized DOM, styles, source candidates, and console context.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await service.getSelectionContext(), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    'patchlens.get_active_selection',
    {
      title: 'Get active PatchLens selection',
      description: 'Return current non-stale visual selection for this project.',
      inputSchema: z.object({}),
    },
    async () => toolResult(() => service.getActiveSelection()),
  );

  server.registerTool(
    'patchlens.get_selection_context',
    {
      title: 'Get PatchLens selection context',
      description: 'Return sanitized visual, DOM, style, source, and console context.',
      inputSchema: z.object({}),
    },
    async () => toolResult(() => service.getSelectionContext()),
  );

  server.registerTool(
    'patchlens.get_source_context',
    {
      title: 'Get selected source context',
      description:
        'Read only source files already linked to active selection; arbitrary paths are rejected.',
      inputSchema: z.object({
        path: z.string().max(4_096).optional(),
        contextLines: z.number().int().min(0).max(100).optional(),
      }),
    },
    async ({ path, contextLines }) =>
      toolResult(async () => ({
        files: await service.getSourceContext({ path, contextLines }),
      })),
  );

  server.registerTool(
    'patchlens.capture_preview',
    {
      title: 'Capture verification baseline',
      description:
        'Store current selection context and available selected-region screenshot as verification baseline.',
      inputSchema: z.object({}),
    },
    async () => toolResult(() => service.capturePreview()),
  );

  server.registerTool(
    'patchlens.get_console_errors',
    {
      title: 'Get active console errors',
      description: 'Return captured runtime errors linked to active selection.',
      inputSchema: z.object({}),
    },
    async () => toolResult(async () => ({ errors: await service.getConsoleErrors() })),
  );

  server.registerTool(
    'patchlens.verify_visual_change',
    {
      title: 'Verify visual change',
      description:
        'Compare active selection with captured baseline and run only allowlisted verification command IDs.',
      inputSchema: z.object({
        commands: z.array(verificationCommandSchema).max(4).default([]),
      }),
    },
    async ({ commands }) =>
      toolResult(() => service.verifyVisualChange(commands as VerificationCommandId[])),
  );

  return server;
}

export async function startPatchLensMcpServer(
  options: StartPatchLensMcpServerOptions = {},
): Promise<void> {
  const sessionPath = options.sessionPath ?? (await discoverPatchLensSession(options.cwd));
  if (!sessionPath) {
    throw new Error('PatchLens session not found; run patchlens dev first');
  }
  const session = await loadPatchLensSession(sessionPath);
  const service = new PatchLensContextService({ session });
  await serveStdio(() => createPatchLensMcpServer(service));
}

async function toolResult(action: () => Promise<unknown>) {
  try {
    const value = await action();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(value, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : 'PatchLens MCP tool failed',
        },
      ],
    };
  }
}
