import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runAllowedVerificationCommands } from '../src/commands.js';

let cwd: string | undefined;

afterEach(async () => {
  if (cwd) {
    await rm(cwd, { recursive: true, force: true });
    cwd = undefined;
  }
});

describe('verification command allowlist', () => {
  it('runs only trusted command definitions without a shell', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'patchlens-verifier-command-'));

    const results = await runAllowedVerificationCommands(['test'], {
      cwd,
      allowlist: {
        test: {
          command: process.execPath,
          args: ['-e', "process.stdout.write('verified')"],
        },
      },
    });

    expect(results).toEqual([
      expect.objectContaining({
        id: 'test',
        ok: true,
        exitCode: 0,
        stdout: 'verified',
      }),
    ]);
  });

  it('rejects arbitrary shell text received as a command ID', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'patchlens-verifier-command-'));

    await expect(
      runAllowedVerificationCommands(['pnpm test' as 'test'], {
        cwd,
        allowlist: {
          test: { command: process.execPath, args: ['--version'] },
        },
      }),
    ).rejects.toThrow('not allowed');
  });

  it('captures failed command output', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'patchlens-verifier-command-'));

    const [result] = await runAllowedVerificationCommands(['lint'], {
      cwd,
      allowlist: {
        lint: {
          command: process.execPath,
          args: ['-e', "process.stderr.write('lint failed'); process.exit(2)"],
        },
      },
    });

    expect(result).toMatchObject({
      id: 'lint',
      ok: false,
      exitCode: 2,
      stderr: 'lint failed',
    });
  });

  it('terminates the full process tree after timeout', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'patchlens-verifier-command-'));
    const script =
      process.platform === 'win32'
        ? 'setInterval(() => {}, 1000);'
        : [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            'process.stdout.write(String(child.pid));',
            'setInterval(() => {}, 1000);',
          ].join('');

    const [result] = await runAllowedVerificationCommands(['test'], {
      cwd,
      allowlist: {
        test: {
          command: process.execPath,
          args: ['-e', script],
          timeoutMs: 200,
        },
      },
    });
    expect(result).toMatchObject({ id: 'test', ok: false, timedOut: true });
    if (process.platform !== 'win32') {
      const nestedPid = Number(result.stdout);
      const nestedProcessRunning = Number.isInteger(nestedPid) && isProcessRunning(nestedPid);
      if (nestedProcessRunning) {
        process.kill(nestedPid, 'SIGKILL');
      }
      expect(nestedPid).toBeGreaterThan(0);
      expect(nestedProcessRunning).toBe(false);
    }
  });
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
