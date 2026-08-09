#!/usr/bin/env node

import { runCli } from "@patchlens-ai/cli";

process.exitCode = await runCli();
