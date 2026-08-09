import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest } from "@patchlens-ai/agent-protocol";

import {
  MockCodingProvider,
  buildProviderPrompt,
  parseProviderResponse,
} from "./index.js";

const request: AgentRequest = {
  provider: "mock",
  instruction: "text: Launch workspace",
  scopePolicy: "prefer-selection",
  selection: {
    id: "selection_test",
    kind: "element",
    route: "/",
    viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    rectangle: { x: 10, y: 20, width: 120, height: 40 },
    confidence: "exact",
    createdAt: new Date(0).toISOString(),
    elements: [],
    primaryElement: {
      tagName: "button",
      text: "Start planning",
      directText: "Start planning",
      html: "<button>Start planning</button>",
      rectangle: { x: 10, y: 20, width: 120, height: 40 },
      source: {
        id: "source_test",
        framework: "react",
        componentName: "Hero",
        file: "src/Hero.tsx",
        line: 12,
        column: 4,
      },
    },
  },
};

test("mock provider proposes a grounded exact replacement", async () => {
  const result = await new MockCodingProvider().run({
    request,
    projectRoot: ".",
  });

  assert.deepEqual(result.plannedFiles, ["src/Hero.tsx"]);
  assert.deepEqual(result.replacements, [{
    file: "src/Hero.tsx",
    expectedText: "Start planning",
    replacementText: "Launch workspace",
  }]);
});

test("parses fenced provider JSON", () => {
  const result = parseProviderResponse(`\`\`\`json
{"reply":"Done","edits":[{"file":"src/Hero.tsx","expectedText":"Old","replacementText":"New"}]}
\`\`\``);

  assert.equal(result.reply, "Done");
  assert.deepEqual(result.plannedFiles, ["src/Hero.tsx"]);
});

test("provider prompt treats captured page data as untrusted", () => {
  const prompt = buildProviderPrompt(request);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /do not modify files/i);
  assert.match(prompt, /PATCHLENS_INPUT_START/);
});

test("keeps an oversized provider payload as valid bounded JSON", () => {
  const prompt = buildProviderPrompt({
    ...request,
    instruction: "change ".repeat(20_000),
    context: {
      selection: request.selection,
      sanitizedHtml: `<main>${"content".repeat(30_000)}</main>`,
      computedStyles: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [`property-${index}`, "x".repeat(500)]),
      ),
      accessibilitySummary: "summary".repeat(5000),
      consoleErrors: Array.from({ length: 100 }, () => "error".repeat(500)),
      capturedAt: new Date(0).toISOString(),
      approximateBytes: 1_000_000,
      truncated: { html: false, styles: false, consoleErrors: false },
    },
  });
  const payload = prompt.split("PATCHLENS_INPUT_START\n")[1]
    ?.split("\nPATCHLENS_INPUT_END")[0];

  assert.ok(payload);
  assert.doesNotThrow(() => JSON.parse(payload));
  assert.ok(payload.length <= 80_000);
});

test("extracts provider JSON after log lines containing unrelated braces", () => {
  const result = parseProviderResponse([
    "debug {not-json}",
    '{"reply":"Done","edits":[]}',
    "finished",
  ].join("\n"));

  assert.equal(result.reply, "Done");
  assert.deepEqual(result.replacements, []);
});
