import { createParser, type EventSourceMessage } from "eventsource-parser";

export const MUSE_SHELL_ALIAS = "run_command";

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameFunction(value: unknown, from: string, to: string): boolean {
  if (!object(value) || value.type !== "function" || value.name !== from) {
    return false;
  }
  value.name = to;
  return true;
}

function renameCall(value: unknown): boolean {
  if (
    !object(value) ||
    value.type !== "function_call" ||
    value.name !== MUSE_SHELL_ALIAS
  ) {
    return false;
  }
  value.name = "shell";
  return true;
}

function restoreOutput(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let changed = false;
  for (const item of value) changed = renameCall(item) || changed;
  return changed;
}

function restoreResponseValue(value: unknown): boolean {
  if (!object(value)) return false;
  let changed = renameCall(value.item);
  changed = restoreOutput(value.output) || changed;
  if (object(value.response)) {
    changed = restoreOutput(value.response.output) || changed;
  }
  return changed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function prepareMuseToolRequest(
  request: Request,
): Promise<Request> {
  if (!request.body || request.bodyUsed) return request;
  let value: unknown;
  try {
    value = parseJson(await request.clone().text());
  } catch {
    return request;
  }
  if (!object(value)) return request;

  if (
    Array.isArray(value.tools) &&
    value.tools.some(
      (tool: unknown) =>
        object(tool) &&
        tool.type === "function" &&
        tool.name === MUSE_SHELL_ALIAS,
    )
  ) {
    throw new Error("Muse function tool alias collision.");
  }

  let changed = false;
  if (Array.isArray(value.tools)) {
    for (const tool of value.tools) {
      changed = renameFunction(tool, "shell", MUSE_SHELL_ALIAS) || changed;
    }
  }
  if (Array.isArray(value.input)) {
    for (const item of value.input) {
      if (
        object(item) &&
        item.type === "function_call" &&
        item.name === "shell"
      ) {
        item.name = MUSE_SHELL_ALIAS;
        changed = true;
      }
    }
  }
  if (object(value.tool_choice)) {
    changed =
      renameFunction(value.tool_choice, "shell", MUSE_SHELL_ALIAS) || changed;
    if (
      value.tool_choice.type === "allowed_tools" &&
      Array.isArray(value.tool_choice.tools)
    ) {
      for (const tool of value.tool_choice.tools) {
        changed = renameFunction(tool, "shell", MUSE_SHELL_ALIAS) || changed;
      }
    }
  }
  if (!changed) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { headers, body: JSON.stringify(value) });
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return headers;
}

function responseWithBody(response: Response, body: BodyInit): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

function serializeEvent(event: EventSourceMessage): string {
  const value = parseJson(event.data);
  const data = restoreResponseValue(value) ? JSON.stringify(value) : event.data;
  let result = event.id === undefined ? "" : `id: ${event.id}\n`;
  if (event.event !== undefined) result += `event: ${event.event}\n`;
  for (const line of data.split("\n")) result += `data: ${line}\n`;
  return `${result}\n`;
}

function restoreStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let controller: TransformStreamDefaultController<Uint8Array>;
  const parser = createParser({
    // Permit large completed tool calls without buffering an unlimited event.
    maxBufferSize: 16 * 1024 * 1024,
    onError(error) {
      if (error.type === "max-buffer-size-exceeded") {
        throw new Error(
          "Muse response event exceeded the streaming size limit.",
        );
      }
    },
    onEvent: (event) =>
      controller.enqueue(encoder.encode(serializeEvent(event))),
    onComment: (comment) =>
      controller.enqueue(encoder.encode(`: ${comment}\n`)),
    onRetry: (retry) => controller.enqueue(encoder.encode(`retry: ${retry}\n`)),
  });
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      transform(chunk) {
        parser.feed(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        parser.feed(decoder.decode());
      },
    }),
  );
}

export async function restoreMuseToolResponse(
  response: Response,
): Promise<Response> {
  if (!response.ok || !response.body || response.bodyUsed) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return responseWithBody(response, restoreStream(response.body));
  }
  if (
    !contentType.includes("application/json") &&
    !contentType.includes("+json")
  ) {
    return response;
  }
  let value: unknown;
  try {
    value = parseJson(await response.clone().text());
  } catch {
    return response;
  }
  if (!restoreResponseValue(value)) return response;
  return responseWithBody(response, JSON.stringify(value));
}
