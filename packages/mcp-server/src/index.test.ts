import assert from "node:assert/strict";
import test from "node:test";

import { handlePatchLensMcpRequest, resolveDaemonUrl } from "./index.js";

test("lists read-only PatchLens MCP tools", async () => {
  const response = await handlePatchLensMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      daemonUrl: "http://127.0.0.1:4311",
      authToken: undefined,
      fetchImplementation: fetch,
    },
  );
  const result = response?.result as { tools: Array<{ name: string }> };
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "patchlens_get_active_selection",
      "patchlens_list_transactions",
      "patchlens_get_source_context",
      "patchlens_get_console_errors",
    ],
  );
});

test("returns the active selection through the authenticated MCP tool", async () => {
  const fetchImplementation = async (_input: unknown, init?: RequestInit) => {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer daemon_test_token",
    );
    return new Response(
      JSON.stringify({ selection: { id: "selection_test" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const response = await handlePatchLensMcpRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "patchlens_get_active_selection", arguments: {} },
    },
    {
      daemonUrl: "http://127.0.0.1:4311",
      authToken: "daemon_test_token",
      fetchImplementation: fetchImplementation as typeof fetch,
    },
  );
  const result = response?.result as { structuredContent: { data: unknown } };
  assert.deepEqual(result.structuredContent.data, {
    selection: { id: "selection_test" },
  });
});

test("does not answer JSON-RPC notifications without an id", async () => {
  const response = await handlePatchLensMcpRequest(
    { jsonrpc: "2.0", method: "ping" },
    {
      daemonUrl: "http://127.0.0.1:4311",
      authToken: undefined,
      fetchImplementation: fetch,
    },
  );
  assert.equal(response, undefined);
});

test("only accepts a plain loopback daemon URL", () => {
  assert.equal(resolveDaemonUrl("http://127.0.0.1:4311"), "http://127.0.0.1:4311");
  assert.throws(
    () => resolveDaemonUrl("https://127.0.0.1:4311"),
    /loopback interface/,
  );
  assert.throws(
    () => resolveDaemonUrl("http://127.0.0.1:4311/other"),
    /loopback interface/,
  );
  assert.throws(
    () => resolveDaemonUrl("http://user:pass@127.0.0.1:4311"),
    /loopback interface/,
  );
});
