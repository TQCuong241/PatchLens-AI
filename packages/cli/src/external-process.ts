import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process';
import { createRequire } from 'node:module';

type ExternalProcessLauncher = {
  (command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  sync(
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string>;
};

const require = createRequire(import.meta.url);

export const spawnExternal = require('cross-spawn') as ExternalProcessLauncher;
