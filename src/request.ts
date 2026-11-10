import { randomUUID } from "node:crypto";

export const MUSE_RESPONSES_URL = "https://api.meta.ai/v1/responses";
export const MUSE_BASE_URL = "https://api.meta.ai/v1";
// Captured from Muse Code 1.4.14-R7309.1 with synthetic credentials.
export const MUSE_USER_AGENT =
  "muse-build/1.4.14 (non-interactive; linux-x86_64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)";

export function validateMuseBaseURL(baseURL?: string): string {
  if (baseURL === undefined) return MUSE_BASE_URL;
  if (!baseURL) {
    throw new Error(`Muse requests must use ${MUSE_BASE_URL}.`);
  }

  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("Muse baseURL must be an absolute HTTPS URL.");
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (
    url.origin !== "https://api.meta.ai" ||
    path !== "/v1" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Muse requests must use ${MUSE_BASE_URL}; custom endpoints are not supported.`,
    );
  }

  return MUSE_BASE_URL;
}

export function validateMuseRequestURL(requestURL: string): void {
  let url: URL;
  try {
    url = new URL(requestURL);
  } catch {
    throw new Error(
      "Refusing to send Muse credentials to an invalid endpoint.",
    );
  }

  if (
    url.origin !== "https://api.meta.ai" ||
    url.pathname !== "/v1/responses" ||
    url.search ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Refusing to send Muse credentials to an unexpected endpoint. Expected ${MUSE_RESPONSES_URL}.`,
    );
  }
}

export function setMuseRequestHeaders(headers: Headers, apiKey: string): void {
  const sessionID = randomUUID();
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("user-agent", MUSE_USER_AGENT);
  headers.set("x-client-id", "tbh:exec");
  headers.set("x-tbh-session-id", sessionID);
  headers.set("x-meta-ai-gateway-session-id", sessionID);
  headers.set("x-tbh-thread-id", sessionID);
  headers.set("x-tbh-root-session-id", sessionID);
  headers.set("x-tbh-agent-role", "main");
  headers.set("accept", "text/event-stream");
  headers.set("accept-encoding", "gzip,deflate,br");
  headers.set("traceparent", traceparent());
}

function traceparent(): string {
  return `00-${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`;
}
