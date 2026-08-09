import assert from "node:assert/strict";
import test from "node:test";

import {
  isInspectorMessage,
  isStudioMessage,
  PATCHLENS_MESSAGE_SOURCE,
} from "./index.js";

const selectedElement = {
  patchlensId: "pl_button",
  tagName: "button",
  text: "Start planning",
  directText: "Start planning",
  html: "<button>Start planning</button>",
  rectangle: { x: 10, y: 20, width: 120, height: 40 },
  source: {
    id: "source_test",
    framework: "react" as const,
    componentName: "Hero",
    file: "src/Hero.tsx",
    line: 12,
    column: 4,
  },
};

const selection = {
  id: "selection_test",
  kind: "element" as const,
  route: "/",
  viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
  rectangle: { x: 10, y: 20, width: 120, height: 40 },
  elements: [selectedElement],
  primaryElement: selectedElement,
  confidence: "exact" as const,
  createdAt: new Date(0).toISOString(),
};

test("accepts a complete inspector selection message", () => {
  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection",
      payload: selection,
    }),
    true,
  );
});

test("rejects malformed or unknown inspector messages", () => {
  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection",
      payload: { ...selection, rectangle: { x: "0" } },
    }),
    false,
  );
  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:unknown",
      payload: {},
    }),
    false,
  );
  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection",
      payload: {
        ...selection,
        primaryElement: {
          ...selectedElement,
          source: { ...selectedElement.source, file: "src/Other.tsx" },
        },
      },
    }),
    false,
  );
});

test("accepts bounded selection context and rejects oversized fields", () => {
  const context = {
    selection,
    sanitizedHtml: "<button>Start planning</button>",
    computedStyles: { color: "rgb(0, 0, 0)" },
    accessibilitySummary: "role=button; name=\"Start planning\"",
    consoleErrors: [],
    capturedAt: new Date(0).toISOString(),
    approximateBytes: 256,
    truncated: { html: false, styles: false, consoleErrors: false },
  };

  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection-context",
      payload: context,
    }),
    true,
  );
  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection-context",
      payload: { ...context, sanitizedHtml: "x".repeat(12_001) },
    }),
    false,
  );
});

test("validates Studio controls and selection consistency", () => {
  assert.equal(
    isStudioMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "studio:set-inspector-mode",
      payload: { enabled: true },
    }),
    true,
  );
  assert.equal(
    isStudioMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "studio:set-inspector-mode",
      payload: { enabled: "yes" },
    }),
    false,
  );
  assert.equal(
    isInspectorMessage({
      source: PATCHLENS_MESSAGE_SOURCE,
      type: "inspector:selection",
      payload: {
        ...selection,
        primaryElement: { ...selectedElement, patchlensId: "pl_other" },
      },
    }),
    false,
  );
});
