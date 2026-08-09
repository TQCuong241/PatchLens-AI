import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PatchTransactionConflictError,
  PatchTransactionManager,
  createUnifiedDiff,
} from "./index.js";

test("applies and safely reverts a text transaction", async () => {
  const fixture = await createFixture();

  try {
    const transaction = await fixture.manager.applyTextReplacement({
      sessionId: "session_test",
      selectionId: "selection_test",
      instruction: "text: Launch workspace",
      file: "src/App.tsx",
      expectedText: "Start planning",
      replacementText: "Launch workspace",
    });

    assert.equal(transaction.status, "applied");
    assert.equal(transaction.undoAvailable, true);
    assert.match(transaction.files[0]?.diff ?? "", /^-.*Start planning/m);
    assert.match(transaction.files[0]?.diff ?? "", /^\+.*Launch workspace/m);
    assert.match(await readFile(fixture.file, "utf8"), /Launch workspace/);

    const reverted = await fixture.manager.undo(transaction.id);
    assert.equal(reverted.status, "reverted");
    assert.equal(reverted.undoAvailable, false);
    assert.match(await readFile(fixture.file, "utf8"), /Start planning/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses undo after a concurrent developer edit", async () => {
  const fixture = await createFixture();

  try {
    const transaction = await fixture.manager.applyTextReplacement({
      sessionId: "session_test",
      selectionId: "selection_test",
      instruction: "text: Launch workspace",
      file: "src/App.tsx",
      expectedText: "Start planning",
      replacementText: "Launch workspace",
    });

    await writeFile(fixture.file, "export const value = 'developer edit';\n", "utf8");

    await assert.rejects(
      () => fixture.manager.undo(transaction.id),
      (error: unknown) => error instanceof PatchTransactionConflictError,
    );
    assert.equal(
      await readFile(fixture.file, "utf8"),
      "export const value = 'developer edit';\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects paths outside the configured project root", async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      () => fixture.manager.applyTextReplacement({
        sessionId: "session_test",
        selectionId: "selection_test",
        instruction: "text: Launch workspace",
        file: "../outside.tsx",
        expectedText: "Start planning",
        replacementText: "Launch workspace",
      }),
      /invalid project-relative file path|outside the configured project root/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("returns a transaction error for malformed replacement input", async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      () => fixture.manager.applyTextReplacements({
        sessionId: "session_test",
        selectionId: "selection_test",
        instruction: "update",
        changes: [{
          file: "",
          expectedText: "old",
          replacementText: "new",
        }],
      }),
      /project-relative file/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects malformed transaction scope metadata", async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      () => fixture.manager.applyTextReplacements({
        sessionId: "session_test",
        selectionId: "selection_test",
        instruction: "update",
        changes: [{
          file: "src/App.tsx",
          expectedText: "Start planning",
          replacementText: "Launch workspace",
        }],
        selectedFiles: "src/App.tsx" as unknown as string[],
      }),
      /selected source scope/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("applies and reverts an atomic multi-file transaction", async () => {
  const fixture = await createFixture();
  const styleFile = path.join(fixture.root, "src", "styles.css");
  await writeFile(styleFile, ".button { color: red; }\n", "utf8");

  try {
    const transaction = await fixture.manager.applyTextReplacements({
      sessionId: "session_multi",
      selectionId: "selection_multi",
      instruction: "Update the call to action and its color",
      selectedFiles: ["src/App.tsx"],
      scopePolicy: "prefer-selection",
      approvedScopeExpansion: ["src/styles.css"],
      changes: [
        {
          file: "src/App.tsx",
          expectedText: "Start planning",
          replacementText: "Launch workspace",
        },
        {
          file: "src/styles.css",
          expectedText: "color: red",
          replacementText: "color: green",
        },
      ],
    });

    assert.equal(transaction.files.length, 2);
    assert.deepEqual(transaction.scopeExpansion, ["src/styles.css"]);
    assert.match(await readFile(fixture.file, "utf8"), /Launch workspace/);
    assert.match(await readFile(styleFile, "utf8"), /color: green/);

    const reverted = await fixture.manager.undo(transaction.id);
    assert.equal(reverted.status, "reverted");
    assert.match(await readFile(fixture.file, "utf8"), /Start planning/);
    assert.match(await readFile(styleFile, "utf8"), /color: red/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("requires approval before expanding beyond the selected source", async () => {
  const fixture = await createFixture();
  const styleFile = path.join(fixture.root, "src", "styles.css");
  await writeFile(styleFile, ".button { color: red; }\n", "utf8");

  try {
    await assert.rejects(
      () => fixture.manager.applyTextReplacements({
        sessionId: "session_scope",
        selectionId: "selection_scope",
        instruction: "Update related styles",
        selectedFiles: ["src/App.tsx"],
        scopePolicy: "prefer-selection",
        changes: [
          {
            file: "src/styles.css",
            expectedText: "color: red",
            replacementText: "color: green",
          },
        ],
      }),
      /Approval is required/,
    );
    assert.match(await readFile(styleFile, "utf8"), /color: red/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loads transaction history after the manager restarts", async () => {
  const fixture = await createFixture();

  try {
    const transaction = await fixture.manager.applyTextReplacement({
      sessionId: "session_persisted",
      selectionId: "selection_persisted",
      instruction: "text: Launch workspace",
      file: "src/App.tsx",
      expectedText: "Start planning",
      replacementText: "Launch workspace",
    });

    const restarted = new PatchTransactionManager({ projectRoot: fixture.root });
    await restarted.ready();
    assert.equal(restarted.get(transaction.id)?.status, "applied");
    assert.equal(restarted.list("session_persisted").length, 1);

    const reverted = await restarted.undo(transaction.id);
    assert.equal(reverted.status, "reverted");
    assert.match(await readFile(fixture.file, "utf8"), /Start planning/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preserves a developer edit detected immediately before the file commit", async () => {
  const fixture = await createFixture();
  const manager = fixture.manager as unknown as {
    readAuthorizedSnapshot(file: string): Promise<unknown>;
  };
  const originalRead = manager.readAuthorizedSnapshot.bind(manager);
  let readCount = 0;
  manager.readAuthorizedSnapshot = async (file: string) => {
    readCount += 1;
    if (readCount === 4) {
      await writeFile(fixture.file, "export const value = 'developer edit';\n", "utf8");
    }
    return originalRead(file);
  };

  try {
    await assert.rejects(
      () => fixture.manager.applyTextReplacement({
        sessionId: "session_race",
        selectionId: "selection_race",
        instruction: "text: Launch workspace",
        file: "src/App.tsx",
        expectedText: "Start planning",
        replacementText: "Launch workspace",
      }),
      /changed while PatchLens was preparing/,
    );
    assert.equal(
      await readFile(fixture.file, "utf8"),
      "export const value = 'developer edit';\n",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("creates separate unified diff hunks and accurate line counts", async () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
  const after = "a\nB\nc\nd\ne\nf\ng\nH\ni\n";
  const diff = createUnifiedDiff("src/App.tsx", before, after, 1);

  assert.equal((diff.match(/^@@/gm) ?? []).length, 2);
  assert.match(diff, /^-b$/m);
  assert.match(diff, /^\+B$/m);
  assert.doesNotMatch(diff, /^-d$/m);

  const fixture = await createFixture();
  try {
    await writeFile(fixture.file, before, "utf8");
    const transaction = await fixture.manager.applyTextReplacements({
      sessionId: "session_diff",
      selectionId: "selection_diff",
      instruction: "Update two distant labels",
      selectedFiles: ["src/App.tsx"],
      changes: [
        { file: "src/App.tsx", expectedText: "b", replacementText: "B" },
        { file: "src/App.tsx", expectedText: "h", replacementText: "H" },
      ],
    });
    assert.equal(transaction.files[0]?.additions, 2);
    assert.equal(transaction.files[0]?.deletions, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps newline markers correct for empty-file diffs", () => {
  const added = createUnifiedDiff("src/Empty.ts", "", "value\n");
  const removed = createUnifiedDiff("src/Empty.ts", "value\n", "");

  assert.match(added, /@@ -0,0 \+1 @@/);
  assert.match(added, /^\+value$/m);
  assert.doesNotMatch(added, /No newline at end of file/);
  assert.match(removed, /@@ -1 \+0,0 @@/);
  assert.match(removed, /^-value$/m);
  assert.doesNotMatch(removed, /No newline at end of file/);
});

async function createFixture(): Promise<{
  root: string;
  file: string;
  manager: PatchTransactionManager;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "patchlens-transaction-"));
  const sourceDirectory = path.join(root, "src");
  const file = path.join(sourceDirectory, "App.tsx");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    file,
    "export function App() {\n  return <button>Start planning</button>;\n}\n",
    "utf8",
  );

  return {
    root,
    file,
    manager: new PatchTransactionManager({ projectRoot: root }),
  };
}
