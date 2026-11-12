import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MUSE_USER_AGENT, validateMuseBaseURL } from "./request.js";

const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";

const MINT_ATTEMPTS = 3;
const MINT_TIMEOUT_MS = 10_000;
const MINT_RETRY_DELAY_MS = 250;
const MINT_MAX_RETRY_AFTER_MS = 2_000;
// The mint endpoint returns the same key for the same login, so a short cache
// only removes redundant round trips; it never extends a key's lifetime.
const KEY_CACHE_TTL_MS = 5 * 60_000;

const keyCache = new Map<string, { key: string; expiresAt: number }>();
const pendingMints = new Map<string, Promise<string>>();

export function museAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSE_AUTH_PATH) return env.MUSE_AUTH_PATH;

  return join(
    env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "muse",
    "auth.json",
  );
}

/** Forget minted keys, e.g. after the model API rejected one. */
export function invalidateMuseSubscriptionKeys(): void {
  keyCache.clear();
}

export async function resolveMuseSubscriptionKey(
  options: {
    authPath?: string;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    /** Base delay between mint retries; tests set 0. */
    retryDelayMs?: number;
  } = {},
): Promise<string | undefined> {
  options.signal?.throwIfAborted();

  const authPath = options.authPath ?? museAuthPath();
  const accessToken = await readOAuthAccessToken(authPath);
  if (!accessToken) return undefined;

  const cacheKey = `${authPath}\n${accessToken}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  // Concurrent sessions share one mint, which runs on its own timeout so one
  // caller's cancellation cannot fail the others.
  let pending = pendingMints.get(cacheKey);
  if (!pending) {
    const started = mintWithRetry(
      accessToken,
      options.fetch ?? globalThis.fetch,
      options.retryDelayMs ?? MINT_RETRY_DELAY_MS,
    )
      .then((key) => {
        keyCache.set(cacheKey, {
          key,
          expiresAt: Date.now() + KEY_CACHE_TTL_MS,
        });
        return key;
      })
      .finally(() => {
        if (pendingMints.get(cacheKey) === started) {
          pendingMints.delete(cacheKey);
        }
      });
    pendingMints.set(cacheKey, started);
    pending = started;
  }
  return untilAborted(pending, options.signal);
}

async function readOAuthAccessToken(
  authPath: string,
): Promise<string | undefined> {
  try {
    if (!(await stat(authPath)).isFile()) return undefined;
    const raw: unknown = JSON.parse(
      await readFile(authPath, { encoding: "utf8" }),
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
    return storedToken;
  } catch {
    // Do not surface credentials or filesystem details in model errors.
    return undefined;
  }
}

type MintAttempt =
  | { kind: "response"; response: Response }
  | { kind: "transport"; reason: string };

async function mintWithRetry(
  accessToken: string,
  fetchImpl: typeof globalThis.fetch,
  retryDelayMs: number,
): Promise<string> {
  let lastFailure = "";
  let lastFailureWasHttp = false;

  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
    const result = await attemptMint(accessToken, fetchImpl);

    if (result.kind === "transport") {
      lastFailure = result.reason;
      lastFailureWasHttp = false;
    } else {
      const { response } = result;
      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new Error(
          "Muse Code login was rejected. Run `muse login` again.",
        );
      }
      if (response.ok) return parseMintedKey(response);

      await discardBody(response);
      lastFailure = `HTTP ${response.status}`;
      lastFailureWasHttp = true;
      if (!isTransientStatus(response.status)) break;

      if (attempt < MINT_ATTEMPTS) {
        await delay(retryDelay(response, attempt, retryDelayMs));
        continue;
      }
    }

    if (attempt < MINT_ATTEMPTS) await delay(retryDelayMs * attempt);
  }

  throw new Error(
    lastFailureWasHttp
      ? `Unable to refresh Muse Code subscription credentials (${lastFailure}). Try again later.`
      : `Unable to refresh Muse Code subscription credentials (${lastFailure}). Check the connection and try again.`,
  );
}

async function attemptMint(
  accessToken: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<MintAttempt> {
  try {
    const response = await fetchImpl(MUSE_KEY_URL, {
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
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    return { kind: "response", response };
  } catch (error) {
    return { kind: "transport", reason: describeTransportError(error) };
  }
}

async function parseMintedKey(response: Response): Promise<string> {
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

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelay(
  response: Response,
  attempt: number,
  baseDelayMs: number,
): number {
  const seconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MINT_MAX_RETRY_AFTER_MS);
  }
  return baseDelayMs * attempt;
}

/** A short, credential-free label for a failed fetch (never the message). */
function describeTransportError(error: unknown): string {
  if (isRecord(error) && error.name === "TimeoutError") return "timeout";
  for (const candidate of [error, isRecord(error) ? error.cause : undefined]) {
    if (
      isRecord(candidate) &&
      typeof candidate.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,40}$/.test(candidate.code)
    ) {
      return candidate.code;
    }
  }
  return "network error";
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing the socket is best-effort.
  }
}

function delay(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
