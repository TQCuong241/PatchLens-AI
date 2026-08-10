#!/usr/bin/env node

import { runPatchLensCli } from '@patchlens-ai/cli';

process.exitCode = await runPatchLensCli();
