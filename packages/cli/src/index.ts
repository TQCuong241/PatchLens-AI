import { resolve } from 'node:path';

import {
  connectAttachedAgent,
  disconnectAttachedAgent,
  type AttachedAgentId,
} from './connection.js';
import { runDevelopment } from './dev.js';
import { runDoctor } from './doctor.js';
import { initializeProject } from './init.js';

export * from './config.js';
export * from './connection.js';
export * from './dev.js';
export * from './doctor.js';
export * from './init.js';

export type CliIo = {
  stdout(message: string): void;
  stderr(message: string): void;
};

const defaultIo: CliIo = {
  stdout: console.log,
  stderr: console.error,
};

export async function runPatchLensCli(
  argv = process.argv.slice(2),
  io: CliIo = defaultIo,
): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(helpText());
    return 0;
  }
  if (command === '--version' || command === '-v') {
    io.stdout('0.1.0');
    return 0;
  }

  try {
    if (command === 'init') {
      const options = parseInitArguments(args);
      const result = await initializeProject(options);
      for (const file of result.modifiedFiles) {
        io.stdout(`${options.dryRun ? 'Would update' : 'Updated'} ${file}`);
      }
      for (const backup of result.backupFiles) {
        io.stdout(`Backup ${backup}`);
      }
      if (result.modifiedFiles.length === 0) {
        io.stdout('PatchLens setup already current');
      }
      return 0;
    }

    if (command === 'doctor') {
      const options = parseDoctorArguments(args);
      const result = await runDoctor({ cwd: options.cwd });
      if (options.json) {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        for (const check of result.checks) {
          io.stdout(`${check.status.toUpperCase()} ${check.id}: ${check.message}`);
        }
      }
      return result.ok ? 0 : 1;
    }

    if (command === 'dev') {
      const options = parseDevArguments(args);
      await runDevelopment({
        cwd: options.cwd,
        startHost: options.startHost,
        hostTimeoutMs: options.hostTimeoutMs,
        output: io.stdout,
      });
      return 0;
    }

    if (command === 'connect' || command === 'disconnect') {
      const options = parseAttachedAgentArguments(command, args);
      const result =
        command === 'connect'
          ? await connectAttachedAgent(options.agent, { cwd: options.cwd })
          : await disconnectAttachedAgent(options.agent, { cwd: options.cwd });
      const state = result.connected ? 'connected' : 'disconnected';
      io.stdout(
        result.changed
          ? `${options.agent} ${state} as ${result.serverName}`
          : `${options.agent} already ${state}`,
      );
      return 0;
    }

    io.stderr(`Unknown command: ${command}`);
    io.stderr(helpText());
    return 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : 'PatchLens command failed');
    return 1;
  }
}

type CommonArguments = {
  cwd?: string;
};

type ParsedInitArguments = CommonArguments & {
  dryRun: boolean;
};

type ParsedDoctorArguments = CommonArguments & {
  json: boolean;
};

type ParsedDevArguments = CommonArguments & {
  startHost?: boolean;
  hostTimeoutMs?: number;
};

type ParsedAttachedAgentArguments = CommonArguments & {
  agent: AttachedAgentId;
};

function parseInitArguments(args: string[]): ParsedInitArguments {
  const parsed: ParsedInitArguments = { dryRun: false };
  consumeArguments(args, {
    '--cwd': (value) => {
      parsed.cwd = resolve(value);
    },
    '--dry-run': () => {
      parsed.dryRun = true;
    },
  });
  return parsed;
}

function parseDoctorArguments(args: string[]): ParsedDoctorArguments {
  const parsed: ParsedDoctorArguments = { json: false };
  consumeArguments(args, {
    '--cwd': (value) => {
      parsed.cwd = resolve(value);
    },
    '--json': () => {
      parsed.json = true;
    },
  });
  return parsed;
}

function parseDevArguments(args: string[]): ParsedDevArguments {
  const parsed: ParsedDevArguments = {};
  consumeArguments(args, {
    '--cwd': (value) => {
      parsed.cwd = resolve(value);
    },
    '--no-host': () => {
      parsed.startHost = false;
    },
    '--host': () => {
      parsed.startHost = true;
    },
    '--timeout': (value) => {
      const timeout = Number.parseInt(value, 10);
      if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
        throw new Error('--timeout must be between 1000 and 300000 milliseconds');
      }
      parsed.hostTimeoutMs = timeout;
    },
  });
  return parsed;
}

function parseAttachedAgentArguments(
  command: 'connect' | 'disconnect',
  args: string[],
): ParsedAttachedAgentArguments {
  const [agent, ...options] = args;
  if (agent !== 'codex') {
    throw new Error(`Usage: patchlens ${command} codex [--cwd PATH]`);
  }
  const parsed: ParsedAttachedAgentArguments = { agent };
  consumeArguments(options, {
    '--cwd': (value) => {
      parsed.cwd = resolve(value);
    },
  });
  return parsed;
}

function consumeArguments(args: string[], handlers: Record<string, (value: string) => void>): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const handler = handlers[argument];
    if (!handler) {
      throw new Error(`Unknown option: ${argument}`);
    }

    if (argument === '--cwd' || argument === '--timeout') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      handler(value);
      index += 1;
    } else {
      handler('');
    }
  }
}

function helpText(): string {
  return [
    'PatchLens AI',
    '',
    'Usage:',
    '  patchlens init [--cwd PATH] [--dry-run]',
    '  patchlens dev [--cwd PATH] [--host|--no-host] [--timeout MS]',
    '  patchlens connect codex [--cwd PATH]',
    '  patchlens disconnect codex [--cwd PATH]',
    '  patchlens doctor [--cwd PATH] [--json]',
  ].join('\n');
}
