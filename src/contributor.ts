export const CONTRIBUTOR_MODE_HEADER = "x-tbh-contributor-mode";

// OpenCode keeps the published model IDs; only the wire model changes for
// contributor IDs that the Muse subscription catalog does not serve.
export const CONTRIBUTOR_WIRE_MODELS: Readonly<Record<string, string>> = {
  "muse-ember-1.0-contributor": "muse-ember-1.0",
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isContributorModel(model: unknown): boolean {
  return typeof model === "string" && model.endsWith("-contributor");
}

/**
 * Mark contributor-mode requests with the CLI's consent header and rewrite
 * wire model IDs where the served catalog has no contributor sibling.
 */
export async function prepareMuseContributorRequest(
  request: Request,
): Promise<Request> {
  const headers = new Headers(request.headers);
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    body = undefined;
  }

  const model = object(body) ? body.model : undefined;
  const contributor = isContributorModel(model);
  const wireModel =
    typeof model === "string" ? CONTRIBUTOR_WIRE_MODELS[model] : undefined;

  if (contributor) headers.set(CONTRIBUTOR_MODE_HEADER, "1");
  else headers.delete(CONTRIBUTOR_MODE_HEADER);

  const unchangedHeader =
    headers.get(CONTRIBUTOR_MODE_HEADER) ===
    request.headers.get(CONTRIBUTOR_MODE_HEADER);
  if (!wireModel && unchangedHeader) return request;

  if (wireModel && object(body)) body.model = wireModel;
  headers.delete("content-length");
  return new Request(request, {
    headers,
    ...(wireModel && object(body) ? { body: JSON.stringify(body) } : {}),
  });
}
