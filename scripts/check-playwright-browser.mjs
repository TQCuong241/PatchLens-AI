import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const executablePath = chromium.executablePath();

try {
  await access(executablePath, constants.F_OK);
} catch {
  console.error(
    [
      'Playwright Chromium is not installed.',
      `Expected executable: ${executablePath}`,
      'Install it with: corepack pnpm exec playwright install chromium',
    ].join('\n'),
  );
  process.exitCode = 1;
}
