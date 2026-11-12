import assert from "node:assert/strict";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import {
  MUSE_SHELL_ALIAS,
  prepareMuseToolRequest,
  restoreMuseToolResponse,
} from "../src/tool-alias.js";

async function main() {
  const argumentsText = JSON.stringify({ command: "echo shell run_command" });
  const payload = {
    instructions: "shell and run_command are literal text",
    tools: [
      {
        type: "function",
        name: "shell",
        parameters: {
          type: "object",
          properties: { name: { const: "shell" } },
        },
      },
      { type: "function", name: "read", description: "shell" },
      { type: "other", name: "run_command" },
    ],
    input: [
      { type: "message", name: "shell", content: "shell" },
      {
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: argumentsText,
      },
      { type: "function_call_output", call_id: "c1", output: "shell" },
    ],
    tool_choice: {
      type: "allowed_tools",
      mode: "required",
      tools: [
        { type: "function", name: "shell" },
        { type: "function", name: "read" },
      ],
    },
  };
  const request = new Request("https://example.test/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "123",
      "x-test": "kept",
    },
    body: JSON.stringify(payload),
  });
  const prepared = await prepareMuseToolRequest(request);
  const expected = structuredClone(payload);
  expected.tools[0]!.name = MUSE_SHELL_ALIAS;
  expected.input[1]!.name = MUSE_SHELL_ALIAS;
  (expected as { tool_choice: unknown }).tool_choice = "auto";
  assert.deepEqual(await prepared.json(), expected);
  assert.equal(prepared.headers.get("content-length"), null);
  assert.equal(prepared.headers.get("x-test"), "kept");
  assert.equal(prepared.signal.aborted, false);
  assert.deepEqual(await request.json(), payload);

  const selector = new Request("https://example.test/", {
    method: "POST",
    body: JSON.stringify({ tool_choice: { type: "function", name: "shell" } }),
  });
  assert.deepEqual(await (await prepareMuseToolRequest(selector)).json(), {
    tool_choice: "auto",
  });

  // Muse only accepts tool_choice "auto"; OpenCode sends "none" on the last
  // step of an agent's step budget and a named function for structured output.
  const tools = [
    { type: "function", name: "shell" },
    { type: "function", name: "read" },
    { type: "web_search" },
  ];
  const choose = async (toolChoice: unknown) =>
    (
      await prepareMuseToolRequest(
        new Request("https://example.test/", {
          method: "POST",
          body: JSON.stringify({ tools, tool_choice: toolChoice }),
        }),
      )
    ).json();
  const declared = [
    { type: "function", name: MUSE_SHELL_ALIAS },
    { type: "function", name: "read" },
    { type: "web_search" },
  ];
  for (const toolChoice of ["none", "required", { type: "none" }]) {
    assert.deepEqual(await choose(toolChoice), {
      tools: declared,
      tool_choice: "auto",
    });
  }
  assert.deepEqual(await choose({ type: "function", name: "read" }), {
    tools: [declared[1], declared[2]],
    tool_choice: "auto",
  });
  assert.deepEqual(
    await choose({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "function", name: "shell" }],
    }),
    { tools: [declared[0], declared[2]], tool_choice: "auto" },
  );
  const alreadyAuto = new Request("https://example.test/", {
    method: "POST",
    body: JSON.stringify({ tools: [], tool_choice: "auto" }),
  });
  assert.equal(await prepareMuseToolRequest(alreadyAuto), alreadyAuto);
  const abortController = new AbortController();
  const abortRequest = new Request("https://example.test/", {
    method: "POST",
    signal: abortController.signal,
    body: JSON.stringify({ tools: [{ type: "function", name: "shell" }] }),
  });
  const rewrittenAbortRequest = await prepareMuseToolRequest(abortRequest);
  abortController.abort("stop");
  assert.equal(rewrittenAbortRequest.signal.aborted, true);
  const unchanged = new Request("https://example.test/", {
    method: "POST",
    body: '{"input":"shell"}',
  });
  assert.equal(await prepareMuseToolRequest(unchanged), unchanged);
  const malformed = new Request("https://example.test/", {
    method: "POST",
    body: '{"secret":',
  });
  assert.equal(await prepareMuseToolRequest(malformed), malformed);
  const collision = new Request("https://example.test/", {
    method: "POST",
    body: JSON.stringify({
      tools: [{ type: "function", name: "run_command", description: "secret" }],
    }),
  });
  await assert.rejects(prepareMuseToolRequest(collision), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /collision/i);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });

  const output = [
    {
      type: "function_call",
      name: "run_command",
      call_id: "c1",
      arguments: argumentsText,
    },
    {
      type: "message",
      name: "run_command",
      content: [{ type: "output_text", text: "run_command" }],
    },
    { type: "reasoning", encrypted_content: "run_command" },
  ];
  const jsonResponse = new Response(JSON.stringify({ output }), {
    headers: {
      "content-type": "application/json",
      "content-length": "500",
      "content-encoding": "gzip",
    },
  });
  const restored = await restoreMuseToolResponse(jsonResponse);
  assert.deepEqual(await restored.json(), {
    output: [{ ...output[0], name: "shell" }, output[1], output[2]],
  });
  assert.equal(restored.headers.get("content-length"), null);
  assert.equal(restored.headers.get("content-encoding"), null);
  const failure = new Response(JSON.stringify({ output }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await restoreMuseToolResponse(failure), failure);
  const noBody = new Response(null, { status: 204 });
  assert.equal(await restoreMuseToolResponse(noBody), noBody);
  const invalidJson = new Response('{"private":', {
    headers: { "content-type": "application/json" },
  });
  assert.equal(await restoreMuseToolResponse(invalidJson), invalidJson);
  const unchangedJson = new Response(
    JSON.stringify({ output: [{ type: "message", name: "run_command" }] }),
    { headers: { "content-type": "application/json", "content-length": "12" } },
  );
  assert.equal(await restoreMuseToolResponse(unchangedJson), unchangedJson);

  let sourceController!: ReadableStreamDefaultController<Uint8Array>;
  let cancellation: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    cancel(reason) {
      cancellation = reason;
    },
  });
  const streaming = await restoreMuseToolResponse(
    new Response(source, {
      headers: {
        "content-type": "text/event-stream",
        "content-length": "999",
        "content-encoding": "gzip",
      },
    }),
  );
  assert.equal(streaming.headers.get("content-length"), null);
  assert.equal(streaming.headers.get("content-encoding"), null);
  const encoder = new TextEncoder();
  const first =
    ': heartbeat\r\nretry: 1500\r\nid: evt-1\r\nevent: response.output_item.done\r\ndata: {"item":{"type":"function_call",\r\ndata: "name":"run_command","arguments":"café shell","call_id":"c1"}}\r\n\r\n';
  const bytes = encoder.encode(first);
  const split = bytes.indexOf(0xc3) + 1;
  sourceController.enqueue(bytes.slice(0, split));
  sourceController.enqueue(bytes.slice(split));
  assert.ok(streaming.body);
  const reader = streaming.body.getReader();
  const events: EventSourceMessage[] = [];
  const comments: string[] = [];
  const retries: number[] = [];
  const parser = createParser({
    onEvent: (event) => events.push(event),
    onComment: (comment) => comments.push(comment),
    onRetry: (retry) => retries.push(retry),
  });
  const decoder = new TextDecoder();
  while (events.length < 1) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    parser.feed(decoder.decode(chunk.value, { stream: true }));
  }
  assert.equal(events[0]!.event, "response.output_item.done");
  assert.equal(events[0]!.id, "evt-1");
  assert.deepEqual(JSON.parse(events[0]!.data), {
    item: {
      type: "function_call",
      name: "shell",
      arguments: "café shell",
      call_id: "c1",
    },
  });
  assert.deepEqual(comments, ["heartbeat"]);
  assert.deepEqual(retries, [1500]);
  sourceController.enqueue(
    encoder.encode(
      `event: response.completed\ndata: ${JSON.stringify({ response: { output } })}\n\ndata: [DONE]\n\n`,
    ),
  );
  while (events.length < 3) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    parser.feed(decoder.decode(chunk.value, { stream: true }));
  }
  assert.deepEqual(JSON.parse(events[1]!.data), {
    response: {
      output: [{ ...output[0], name: "shell" }, output[1], output[2]],
    },
  });
  assert.equal(events[2]!.data, "[DONE]");
  await reader.cancel("caller cancelled");
  assert.equal(cancellation, "caller cancelled");

  const sourceError = new Error("upstream failure");
  const failedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(sourceError);
    },
  });
  const failedResponse = await restoreMuseToolResponse(
    new Response(failedStream, {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  assert.ok(failedResponse.body);
  await assert.rejects(
    failedResponse.body.getReader().read(),
    (error: unknown) => error === sourceError,
  );

  console.log("Tool alias tests passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
