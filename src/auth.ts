import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MUSE_USER_AGENT, validateMuseBaseURL } from "./request.js";

const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";

export function museAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSE_AUTH_PATH) return env.MUSE_AUTH_PATH;

  return join(
    env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "muse",
    "auth.json",
  );
}

export async function resolveMuseSubscriptionKey(
  options: {
    authPath?: string;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  let accessToken: string;
  try {
    const authPath = options.authPath ?? museAuthPath();
    if (!(await stat(authPath)).isFile()) return undefined;
    const raw: unknown = JSON.parse(
      await readFile(authPath, { encoding: "utf8", signal }),
    );
    if (!isRecord(raw)) return undefined;

    const providers = raw.providers;
    if (!isRecord(providers)) return undefined;

    const meta = providers.meta;
    if (!isRecord(meta)) return undefined;

    // Only accept credentials from the CLI's browser/device subscription login.
    // Do not silently fall back to API-key billing through environment/config.
    if (meta.mechanism !== "oauth") return undefined;

    const storedToken = meta.access_token;
    if (typeof storedToken !== "string" || storedToken.trim().length === 0) {
      return undefined;
    }
    accessToken = storedToken;
  } catch {
    // Do not surface credentials or filesystem details in model errors.
    return undefined;
  }

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(MUSE_KEY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "user-agent": MUSE_USER_AGENT,
        "x-client-id": "tbh:exec",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
      redirect: "error",
      signal,
    });
  } catch {
    throw new Error(
      "Unable to refresh Muse Code subscription credentials. Check the connection and try again.",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Muse Code login was rejected. Run `muse login` again.");
  }
  if (!response.ok) {
    throw new Error(
      "Unable to refresh Muse Code subscription credentials. Try again later.",
    );
  }

  let minted: unknown;
  try {
    minted = await response.json();
  } catch {
    throw new Error("Muse Code returned an invalid subscription credential.");
  }
  if (!isRecord(minted)) {
    throw new Error("Muse Code returned an invalid subscription credential.");
  }
  if (minted.is_subs_active !== true) {
    throw new Error("An active Muse Code subscription is required.");
  }
  if (
    typeof minted.api_key !== "string" ||
    minted.api_key.trim().length === 0 ||
    (minted.base_url !== undefined && typeof minted.base_url !== "string")
  ) {
    throw new Error("Muse Code returned an invalid subscription credential.");
  }

  validateMuseBaseURL(minted.base_url);
  return minted.api_key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
