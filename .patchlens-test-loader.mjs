import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const workspacePackages = {
    "@patchlens-ai/agent-protocol": "packages/agent-protocol/src/index.ts",
    "@patchlens-ai/coding-provider": "packages/coding-provider/src/index.ts",
    "@patchlens-ai/daemon": "apps/daemon/src/index.ts",
    "@patchlens-ai/inspector-runtime": "packages/inspector-runtime/src/index.ts",
    "@patchlens-ai/mcp-server": "packages/mcp-server/src/index.ts",
    "@patchlens-ai/patch-transaction": "packages/patch-transaction/src/index.ts",
    "@patchlens-ai/studio": "apps/studio/src/main.tsx",
  };
  const workspacePath = workspacePackages[specifier];
  if (workspacePath) {
    return nextResolve(new URL(workspacePath, new URL("file:///C:/Users/tqc24/code/Tool%20Web%20AI/")).href, context);
  }
  if (specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
