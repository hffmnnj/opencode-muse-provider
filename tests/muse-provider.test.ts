import assert from "node:assert/strict";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LLMEvent,
  LLMRequest,
  Media,
  Message,
  ToolDefinition,
} from "@opencode/ai";
import { AI } from "@opencode/ai/promise";
import { protocol } from "@opencode/ai/protocols/meta-responses";
import { responses } from "@opencode/ai/providers/meta";
import sourceMusePlugin from "../src/plugin.js";
import builtMusePlugin from "../dist/index.js";
import {
  invalidateMuseSubscriptionKeys,
  museAuthPath,
  resolveMuseSubscriptionKey,
} from "../src/auth.js";
import type { MuseToolMap } from "../src/tool-descriptions.js";

const runtimeEntrypoint = new URL(
  "../dist/muse-code-1.4.14-r4/server.js",
  import.meta.url,
).href;
const { default: runtimeMusePlugin } = (await import(runtimeEntrypoint)) as {
  default: typeof sourceMusePlugin;
};

interface CapturedProvider {
  info: {
    activation: string;
    name: string;
    package: string;
    settings?: Record<string, unknown>;
  };
  models: Array<{
    capabilities: { input: string[]; output: string[]; tools: boolean };
    id: string;
    limit: { context: number; output: number };
    name: string;
    settings?: Record<string, unknown>;
    variants: Array<{
      id: string;
      settings?: Record<string, unknown>;
    }>;
  }>;
}

interface CapturedHook {
  event: string;
  handler: (
    input:
      { request: Request } | { response: Response } | { tools: MuseToolMap },
  ) => void | Promise<void>;
  options?: { providerID?: string };
}

const testBaseDirectory = tmpdir();
const oauthToken = "oauth-session-token";
const cachedKey = "cached-key-must-not-be-used";
const mintedKey = "freshly-minted-subscription-key";
const museUserAgent =
  "muse-build/1.4.14 (non-interactive; linux-x86_64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)";

function mintFetch(
  response: () => Response | Promise<Response> = () =>
    Response.json({ is_subs_active: true, api_key: mintedKey }),
): typeof globalThis.fetch {
  return async (input, init) => {
    assert.equal(String(input), "https://api.meta.ai/muse-code/key");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal);
    assert.equal(init.body, "{}");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), `Bearer ${oauthToken}`);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("x-client-id"), "tbh:exec");
    assert.equal(headers.get("user-agent"), museUserAgent);
    return response();
  };
}

async function removeFixtureDirectory(configDirectory: string): Promise<void> {
  const operations = [
    () => unlink(join(configDirectory, "muse", "auth.json")),
    () => rmdir(join(configDirectory, "muse")),
    () => rmdir(configDirectory),
  ];

  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mintFetch();
  // Fixture tests must never read an inherited path to real credentials.
  for (const [name, value] of Object.entries({
    MUSE_AUTH_PATH: undefined,
    ...values,
  })) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function captureRegistration(
  plugin: typeof sourceMusePlugin,
  initialProvider?: CapturedProvider,
) {
  let provider = initialProvider;
  const hooks: CapturedHook[] = [];
  const editor = {
    get: (id: string) =>
      id === "muse" && provider
        ? {
            provider: provider.info,
            models: new Map(provider.models.map((model) => [model.id, model])),
          }
        : undefined,
    update: (
      _providerID: string,
      update: (info: { settings?: Record<string, unknown> }) => void,
    ) => {
      assert(provider);
      update(provider.info);
    },
    add: (definition: CapturedProvider) => {
      provider = definition;
    },
    models: {
      set: (_providerID: string, models: readonly unknown[]) => {
        assert(provider);
        provider = {
          info: provider.info,
          models: models as CapturedProvider["models"],
        };
      },
    },
  };
  const context = {
    provider: {
      transform: async (transform: (providerEditor: typeof editor) => void) => {
        transform(editor);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (
        event: string,
        handler: CapturedHook["handler"],
        options?: CapturedHook["options"],
      ) => {
        hooks.push({ event, handler, options });
        return { dispose: async () => {} };
      },
    },
  };

  await plugin.setup(context as never);
  assert(provider, "plugin should register a Muse provider");
  return { provider, hooks };
}

async function writeSubscriptionAuth(
  configDirectory: string,
  apiKey: string | null = cachedKey,
): Promise<string> {
  const authPath = join(configDirectory, "muse", "auth.json");
  await mkdir(join(configDirectory, "muse"), { recursive: true });
  await writeFile(
    authPath,
    JSON.stringify({
      providers: {
        meta: {
          mechanism: "oauth",
          obtained_via: "device_code",
          access_token: oauthToken,
          ...(apiKey === null ? {} : { api_key: apiKey }),
        },
      },
    }),
  );
  return authPath;
}

async function testAuthResolution() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-auth-test-"),
  );
  const authPath = await writeSubscriptionAuth(configDirectory);

  try {
    await withEnvironment(
      {
        MUSE_API_KEY: "ordinary-api-key",
        META_API_KEY: "meta-model-api-key",
        MUSE_AUTH_PATH: undefined,
        XDG_CONFIG_HOME: configDirectory,
      },
      async () => {
        assert.equal(museAuthPath(), authPath);
        assert.equal(await resolveMuseSubscriptionKey(), mintedKey);
        await writeSubscriptionAuth(configDirectory, null);
        assert.equal(await resolveMuseSubscriptionKey(), mintedKey);
        assert.equal(
          museAuthPath({ MUSE_AUTH_PATH: "/custom/muse-auth.json" }),
          "/custom/muse-auth.json",
        );
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testMissingAuthIsSafe() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-missing-auth-"),
  );
  try {
    await withEnvironment(
      { MUSE_API_KEY: undefined, XDG_CONFIG_HOME: configDirectory },
      async () => {
        let mintCalls = 0;
        const noMint: typeof fetch = async () => {
          mintCalls++;
          assert.fail("missing profile must not mint a key");
        };
        assert.equal(
          await resolveMuseSubscriptionKey({ fetch: noMint }),
          undefined,
        );
        await mkdir(join(configDirectory, "muse"), { recursive: true });
        await writeFile(join(configDirectory, "muse", "auth.json"), "{invalid");
        assert.equal(
          await resolveMuseSubscriptionKey({ fetch: noMint }),
          undefined,
        );
        assert.equal(mintCalls, 0);
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testApiKeyOnlyLoginIsNotTreatedAsSubscription() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-api-key-auth-"),
  );
  const authPath = join(configDirectory, "muse", "auth.json");
  await mkdir(join(configDirectory, "muse"), { recursive: true });
  await writeFile(
    authPath,
    JSON.stringify({
      providers: {
        meta: { mechanism: "api_key", api_key: "standalone-api-key" },
      },
    }),
  );

  try {
    await withEnvironment(
      {
        MUSE_API_KEY: "environment-api-key",
        META_API_KEY: "environment-meta-key",
        MUSE_AUTH_PATH: undefined,
        XDG_CONFIG_HOME: configDirectory,
      },
      async () => {
        let mintCalls = 0;
        const noMint: typeof fetch = async () => {
          mintCalls++;
          assert.fail("API-key profile must not mint a key");
        };
        assert.equal(
          await resolveMuseSubscriptionKey({ fetch: noMint }),
          undefined,
        );
        assert.equal(mintCalls, 0);
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testMintFailuresDoNotFallBackOrLeakCredentials() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-mint-failure-"),
  );
  const authPath = await writeSubscriptionAuth(configDirectory);
  const cases: Array<{
    name: string;
    response: () => Response | Promise<Response>;
    login?: boolean;
  }> = [
    {
      name: "unauthorized",
      response: () => new Response(oauthToken, { status: 401 }),
      login: true,
    },
    {
      name: "forbidden",
      response: () => new Response(oauthToken, { status: 403 }),
      login: true,
    },
    {
      name: "server failure",
      response: () => new Response(oauthToken, { status: 500 }),
    },
    {
      name: "transport failure",
      response: async () => {
        throw new Error(oauthToken);
      },
    },
    { name: "invalid JSON", response: () => new Response("not json") },
    {
      name: "inactive subscription",
      response: () =>
        Response.json({ is_subs_active: false, api_key: mintedKey }),
    },
    {
      name: "missing key",
      response: () => Response.json({ is_subs_active: true, api_key: "" }),
    },
    {
      name: "untrusted base URL",
      response: () =>
        Response.json({
          is_subs_active: true,
          api_key: mintedKey,
          base_url: "https://attacker.example/v1",
        }),
    },
  ];
  try {
    for (const { name, response, login } of cases) {
      await assert.rejects(
        resolveMuseSubscriptionKey({ authPath, fetch: mintFetch(response) }),
        (error: unknown) => {
          assert(error instanceof Error, `${name} must throw an error`);
          assert(
            !error.message.includes(oauthToken),
            `${name} leaked the OAuth token`,
          );
          assert(
            !error.message.includes(cachedKey),
            `${name} leaked the cached key`,
          );
          if (login) assert.match(error.message, /muse login/i);
          return true;
        },
        name,
      );
    }
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testMintRetriesCachesAndReportsCause() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-mint-resilience-"),
  );
  const authPath = await writeSubscriptionAuth(configDirectory);
  try {
    // A stale pooled socket (ECONNRESET) and a 503 are retried, then succeed.
    const responses: Array<() => Response> = [
      () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      },
      () => new Response("unavailable", { status: 503 }),
      () => Response.json({ is_subs_active: true, api_key: mintedKey }),
    ];
    let calls = 0;
    const flaky = mintFetch(() => responses[calls++]!());
    const [first, second] = await Promise.all([
      resolveMuseSubscriptionKey({ authPath, fetch: flaky, retryDelayMs: 0 }),
      resolveMuseSubscriptionKey({ authPath, fetch: flaky, retryDelayMs: 0 }),
    ]);
    assert.equal(first, mintedKey);
    assert.equal(second, mintedKey);
    assert.equal(calls, 3, "concurrent callers must share one retried mint");

    const noMint: typeof fetch = async () => assert.fail("cache must serve");
    assert.equal(
      await resolveMuseSubscriptionKey({ authPath, fetch: noMint }),
      mintedKey,
    );

    invalidateMuseSubscriptionKeys();
    calls = 0;
    responses.splice(0, responses.length, () =>
      Response.json({ is_subs_active: true, api_key: "rotated-key" }),
    );
    assert.equal(
      await resolveMuseSubscriptionKey({ authPath, fetch: flaky }),
      "rotated-key",
    );
    invalidateMuseSubscriptionKeys();

    // Exhausted retries name the sanitized cause, never the raw message.
    let attempts = 0;
    await assert.rejects(
      resolveMuseSubscriptionKey({
        authPath,
        retryDelayMs: 0,
        fetch: mintFetch(() => {
          attempts++;
          throw Object.assign(new Error(oauthToken), {
            cause: { code: "ECONNRESET" },
          });
        }),
      }),
      (error: unknown) =>
        error instanceof Error &&
        /\(ECONNRESET\)/.test(error.message) &&
        !error.message.includes(oauthToken),
    );
    assert.equal(attempts, 3);

    // Caller cancellation is surfaced as cancellation, not as a mint failure.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      resolveMuseSubscriptionKey({
        authPath,
        fetch: noMint,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
  } finally {
    invalidateMuseSubscriptionKeys();
    await removeFixtureDirectory(configDirectory);
  }
}

async function testV2ProviderRegistration(plugin: typeof sourceMusePlugin) {
  const { provider, hooks } = await captureRegistration(plugin);
  assert.equal(provider.info.name, "Muse Code");
  assert.equal(provider.info.activation, "enabled");
  assert.equal(provider.info.package, "@opencode/ai/providers/meta/responses");
  assert.deepEqual(provider.info.settings, {
    baseURL: "https://api.meta.ai/v1",
    apiKey: "muse-code-subscription-placeholder",
  });

  const expectedModels = [
    {
      id: "muse-spark-1.2-contributor",
      name: "Muse Spark 1.2 Contributor",
      limit: { context: 1_048_576, output: 131_072 },
      defaultEffort: "low",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "xhigh"],
        ["ultra", "xhigh"],
      ],
    },
    {
      id: "muse-spark-1.3-contributor",
      name: "Muse Spark 1.3 Contributor",
      limit: { context: 1_048_576, output: 131_072 },
      defaultEffort: "low",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "xhigh"],
        ["ultra", "xhigh"],
      ],
    },
    {
      id: "muse-ember-1.0",
      name: "Muse Ember 1.0",
      limit: { context: 1_048_576, output: 131_072 },
      defaultEffort: "low",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "max"],
      ],
    },
    {
      id: "muse-ember-1.0-contributor",
      name: "Muse Ember 1.0 Contributor",
      limit: { context: 1_048_576, output: 131_072 },
      defaultEffort: "low",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "max"],
      ],
    },
    {
      id: "muse-wonder-1.0",
      name: "Muse Wonder 1.0",
      limit: { context: 1_007_997, output: 128_000 },
      defaultEffort: "medium",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "max"],
      ],
    },
    {
      id: "muse-wonder-1.0-contributor",
      name: "Muse Wonder 1.0 Contributor",
      limit: { context: 1_007_997, output: 128_000 },
      defaultEffort: "medium",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "max"],
      ],
    },
    {
      id: "muse-wonder-full-1.0",
      name: "Muse Wonder Full 1.0",
      limit: { context: 1_007_997, output: 128_000 },
      defaultEffort: "medium",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "max"],
      ],
    },
    {
      id: "muse-wonder-full-1.0-contributor",
      name: "Muse Wonder Full 1.0 Contributor",
      limit: { context: 1_007_997, output: 128_000 },
      defaultEffort: "medium",
      variants: [
        ["none", "minimal"],
        ["minimal", "minimal"],
        ["low", "low"],
        ["medium", "medium"],
        ["high", "high"],
        ["xhigh", "xhigh"],
        ["max", "max"],
        ["ultra", "max"],
      ],
    },
  ];

  assert.equal(provider.models.length, 8);
  assert.deepEqual(
    provider.models.map(({ id }) => id),
    expectedModels.map(({ id }) => id),
  );
  assert.equal(new Set(provider.models.map(({ id }) => id)).size, 8);

  for (const model of provider.models) {
    const expected = expectedModels.find(({ id }) => id === model.id);
    assert(expected, `unexpected model ${model.id}`);
    assert.equal(model.name, expected.name);
    assert.equal(model.capabilities.tools, true);
    assert.deepEqual(model.capabilities.input, ["text", "image"]);
    assert.deepEqual(model.capabilities.output, ["text"]);
    assert.deepEqual(model.limit, expected.limit);
    assert.deepEqual(model.settings, {
      reasoningEffort: expected.defaultEffort,
      reasoningSummary: "auto",
    });
    assert.equal(model.variants.length, expected.variants.length);
    for (const [variantID, expectedEffort] of expected.variants) {
      const variant = model.variants.find(({ id }) => id === variantID);
      assert(variant, `missing variant ${variantID} for ${model.id}`);
      // Variants override only effort; summary is inherited from model settings.
      assert.deepEqual(variant.settings, {
        reasoningEffort: expectedEffort,
      });
    }
  }

  assert.deepEqual(
    hooks.map(({ event }) => event),
    ["http.request", "context", "compaction", "generate", "http.response"],
  );
  for (const hook of hooks) {
    assert.equal(hook.options?.providerID, "muse");
  }
}

async function testToolDescriptionHooksAreMuseScoped(
  plugin: typeof sourceMusePlugin,
) {
  const { hooks } = await captureRegistration(plugin);
  for (const kind of ["context", "compaction", "generate"]) {
    const hook = hooks.find(({ event }) => event === kind);
    assert(hook);
    assert.equal(hook.options?.providerID, "muse");
    const tools = {
      shell: {
        description: "original shell help",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "original command help" },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    };
    await hook.handler({ tools });
    assert.notEqual(tools.shell.description, "original shell help");
    assert.notEqual(
      tools.shell.input.properties.command.description,
      "original command help",
    );
    assert.deepEqual(Object.keys(tools), ["shell"]);
    assert.equal(tools.shell.input.properties.command.type, "string");
    assert.deepEqual(tools.shell.input.required, ["command"]);
    assert.equal(tools.shell.input.additionalProperties, false);
  }
}

async function testExistingProviderModelsArePreserved() {
  const userModel: CapturedProvider["models"][number] = {
    id: "user-defined-model",
    name: "User-defined model",
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 16_000, output: 4_000 },
    variants: [],
  };
  const existing: CapturedProvider = {
    info: {
      activation: "enabled",
      name: "My Muse configuration",
      package: "@opencode/ai/providers/meta/responses",
      settings: {
        baseURL: "https://api.meta.ai/v1",
        apiKey: "configured-key-must-be-replaced",
        companyOption: "preserved",
      },
    },
    models: [userModel],
  };

  const { provider } = await captureRegistration(sourceMusePlugin, existing);
  assert.equal(provider.info.name, "My Muse configuration");
  assert.equal(provider.info.package, existing.info.package);
  assert.deepEqual(provider.info.settings, {
    baseURL: "https://api.meta.ai/v1",
    apiKey: "muse-code-subscription-placeholder",
    companyOption: "preserved",
  });
  assert.deepEqual(provider.models[0], userModel);
  // Plugin-owned summary must never leak into user-defined models.
  assert.equal(
    (provider.models[0]?.settings as Record<string, unknown> | undefined)?.[
      "reasoningSummary"
    ],
    undefined,
  );
  assert.deepEqual(
    provider.models.slice(1).map(({ id }) => id),
    [
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "muse-ember-1.0",
      "muse-ember-1.0-contributor",
      "muse-wonder-1.0",
      "muse-wonder-1.0-contributor",
      "muse-wonder-full-1.0",
      "muse-wonder-full-1.0-contributor",
    ],
  );
}

async function testCollidingBuiltinOverrideIsPreservedOnce() {
  const collidingOverride: CapturedProvider["models"][number] = {
    id: "muse-wonder-1.0",
    name: "Custom Wonder display name",
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 16_000, output: 4_000 },
    settings: { reasoningEffort: "high", customOption: "preserved" },
    variants: [
      {
        id: "custom-variant",
        settings: { reasoningEffort: "high" },
      },
    ],
  };
  const unrelatedModel: CapturedProvider["models"][number] = {
    id: "user-defined-model",
    name: "User-defined model",
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    limit: { context: 32_000, output: 8_000 },
    variants: [],
  };
  const existing: CapturedProvider = {
    info: {
      activation: "enabled",
      name: "My Muse configuration",
      package: "@opencode/ai/providers/meta/responses",
      settings: {
        baseURL: "https://api.meta.ai/v1",
        apiKey: "configured-key-must-be-replaced",
      },
    },
    models: [collidingOverride, unrelatedModel],
  };

  const first = await captureRegistration(sourceMusePlugin, existing);
  assert.deepEqual(first.provider.models[0], collidingOverride);
  assert.deepEqual(first.provider.models[1], unrelatedModel);
  // 2 user models + 8 built-ins minus the 1 colliding wonder entry.
  assert.equal(first.provider.models.length, 9);
  assert.deepEqual(
    first.provider.models.map(({ id }) => id),
    [
      "muse-wonder-1.0",
      "user-defined-model",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "muse-ember-1.0",
      "muse-ember-1.0-contributor",
      "muse-wonder-1.0-contributor",
      "muse-wonder-full-1.0",
      "muse-wonder-full-1.0-contributor",
    ],
  );
  assert.equal(
    new Set(first.provider.models.map(({ id }) => id)).size,
    first.provider.models.length,
  );

  const second = await captureRegistration(sourceMusePlugin, first.provider);
  assert.equal(second.provider.models.length, 9);
  assert.deepEqual(
    second.provider.models.map(({ id }) => id),
    first.provider.models.map(({ id }) => id),
  );
  assert.deepEqual(second.provider.models[0], collidingOverride);
  assert.deepEqual(second.provider.models[1], unrelatedModel);
  assert.equal(
    new Set(second.provider.models.map(({ id }) => id)).size,
    second.provider.models.length,
  );
}

async function testNativeImageToolEffortAndSummaryRequests(
  plugin: typeof sourceMusePlugin,
) {
  const { provider, hooks } = await captureRegistration(plugin);
  assert.equal(provider.models.length, 8);
  const hook = hooks[0];
  assert(hook);
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-native-summary-"),
  );
  const ai = AI.make();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=";
  const imageURL = "https://images.example.test/diagram.webp";
  const inputSchema = {
    type: "object",
    properties: { color: { type: "string" } },
    required: ["color"],
    additionalProperties: false,
  };
  // Independent oracle for the decided variant mapping: Spark caps at xhigh;
  // Ember and Wonder cap at max. Mirrors the registration table without calling it.
  function expectedEffortFor(
    modelID: string,
    variantID: string | undefined,
  ): string {
    const isSpark = modelID.startsWith("muse-spark-");
    const isEmber = modelID.startsWith("muse-ember-");
    if (variantID === undefined) return isSpark || isEmber ? "low" : "medium";
    switch (variantID) {
      case "none":
      case "minimal":
        return "minimal";
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "xhigh":
        return "xhigh";
      case "max":
      case "ultra":
        return isSpark ? "xhigh" : "max";
      default:
        throw new Error(`unexpected variant ${variantID}`);
    }
  }

  try {
    await writeSubscriptionAuth(configDirectory);
    await withEnvironment(
      {
        MUSE_AUTH_PATH: undefined,
        XDG_CONFIG_HOME: configDirectory,
        META_API_KEY: "standalone-key-must-not-be-used",
      },
      async () => {
        for (const registered of provider.models) {
          const variantIDs = [
            undefined,
            ...registered.variants.map(({ id }) => id),
          ];
          assert.equal(variantIDs.length, 9);
          for (const variantID of variantIDs) {
            const variant =
              variantID === undefined
                ? undefined
                : registered.variants.find(({ id }) => id === variantID);
            if (variantID !== undefined) assert(variant);
            const expectedEffort = expectedEffortFor(registered.id, variantID);
            // Registration itself must carry the summary request.
            assert.deepEqual(registered.settings, {
              reasoningEffort: expectedEffortFor(registered.id, undefined),
              reasoningSummary: "auto",
            });
            if (variant) {
              // Variants override only effort and inherit summary from the model.
              assert.deepEqual(variant.settings, {
                reasoningEffort: expectedEffort,
              });
            }
            const model = responses(registered.id);
            const request = new LLMRequest({
              model,
              system: [],
              messages: [
                Message.user([
                  Message.text("Compare the images and report their color."),
                  Message.media(
                    new Media.Asset({
                      source: {
                        type: "base64",
                        data: png,
                        mediaType: "image/png",
                      },
                    }),
                  ),
                  Message.media(
                    new Media.Asset({
                      source: {
                        type: "url",
                        url: imageURL,
                        mediaType: "image/webp",
                      },
                    }),
                  ),
                ]),
              ],
              tools: [
                ToolDefinition.make({
                  name: "report_color",
                  description: "Report the observed color",
                  inputSchema,
                }),
              ],
              providerOptions: { ...registered.settings, ...variant?.settings },
            });
            assert.equal(model.route.protocol, protocol.id);
            const lowered = await ai.run(protocol.body.from(request));
            // Assert the JSON wire payload, not optional undefined schema fields.
            const body: typeof lowered = JSON.parse(JSON.stringify(lowered));
            assert.equal(body.model, registered.id);
            assert.equal(body.stream, true);
            assert.deepEqual(body.reasoning, {
              effort: expectedEffort,
              summary: "auto",
            });
            assert.deepEqual(body.input, [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "Compare the images and report their color.",
                  },
                  {
                    type: "input_image",
                    image_url: `data:image/png;base64,${png}`,
                  },
                  { type: "input_image", image_url: imageURL },
                ],
              },
            ]);
            assert.deepEqual(body.tools, [
              {
                type: "function",
                name: "report_color",
                description: "Report the observed color",
                parameters: inputSchema,
                strict: false,
              },
            ]);

            const httpRequest = new Request(
              "https://api.meta.ai/v1/responses",
              {
                method: "POST",
                headers: {
                  authorization: "Bearer muse-code-subscription-placeholder",
                  "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
                },
                body: JSON.stringify(body),
              },
            );
            const event = { request: httpRequest };
            await hook.handler(event);
            assert.equal(
              httpRequest.headers.get("authorization"),
              `Bearer ${mintedKey}`,
            );
            const expectedWire = JSON.parse(JSON.stringify(body));
            if (registered.id === "muse-ember-1.0-contributor") {
              expectedWire.model = "muse-ember-1.0";
            }
            assert.deepEqual(await event.request.json(), expectedWire);
          }
        }
      },
    );
  } finally {
    await ai.dispose();
    await removeFixtureDirectory(configDirectory);
  }
}

async function testMetaReasoningSummaryStreamProducesReadableReasoning() {
  const ai = AI.make();
  try {
    const model = responses("muse-spark-1.3-contributor");
    const request = new LLMRequest({
      model,
      system: [],
      messages: [Message.user([Message.text("What color?")])],
      tools: [],
      providerOptions: { reasoningEffort: "high", reasoningSummary: "auto" },
    });
    type MetaStreamEvent = Parameters<typeof protocol.stream.step>[1];
    let state = protocol.stream.initial(request);
    const seen: LLMEvent[] = [];
    const feed = async (event: MetaStreamEvent) => {
      const [next, emitted] = await ai.run(protocol.stream.step(state, event));
      state = next;
      seen.push(...(emitted as LLMEvent[]));
      return emitted as LLMEvent[];
    };
    const encryptedSentinel = "gAAAAABopaque-encrypted-reasoning-sentinel-001";

    await feed({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_001",
        summary: [],
        encrypted_content: encryptedSentinel,
      },
    });
    await feed({
      type: "response.reasoning_summary_part.added",
      item_id: "rs_001",
      summary_index: 0,
    });
    await feed({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_001",
      summary_index: 0,
      delta: "Comparing both images for ",
    });
    await feed({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_001",
      summary_index: 0,
      delta: "dominant color.",
    });
    await feed({
      type: "response.reasoning_summary_part.done",
      item_id: "rs_001",
      summary_index: 0,
    });
    await feed({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_001",
        summary: [
          {
            type: "summary_text",
            text: "Comparing both images for dominant color.",
          },
        ],
        encrypted_content: encryptedSentinel,
      },
    });

    const starts = seen.filter(LLMEvent.is.reasoningStart);
    const deltas = seen.filter(LLMEvent.is.reasoningDelta);
    const ends = seen.filter(LLMEvent.is.reasoningEnd);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.id, "rs_001:0");
    assert.deepEqual(
      deltas.map((delta) => delta.text),
      ["Comparing both images for ", "dominant color."],
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.text, "Comparing both images for dominant color.");

    // Terminal snapshot replays the completed reasoning item; it must not
    // duplicate readable reasoning text already emitted for rs_001.
    const reasoningCountBefore = seen.filter(
      (event) =>
        event.type === "reasoning-delta" || event.type === "reasoning-end",
    ).length;
    const terminalEvent: MetaStreamEvent = {
      type: "response.completed",
      response: {
        id: "resp_001",
        output: [
          {
            type: "reasoning",
            id: "rs_001",
            summary: [
              {
                type: "summary_text",
                text: "Comparing both images for dominant color.",
              },
            ],
            encrypted_content: encryptedSentinel,
          },
          {
            type: "message",
            id: "msg_001",
            role: "assistant",
            content: [{ type: "output_text", text: "The color is blue." }],
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 30,
        },
      },
    };
    assert(protocol.stream.terminal, "meta-responses terminal must exist");
    assert.equal(protocol.stream.terminal(terminalEvent), true);
    await feed(terminalEvent);
    const reasoningCountAfter = seen.filter(
      (event) =>
        event.type === "reasoning-delta" || event.type === "reasoning-end",
    ).length;
    assert.equal(reasoningCountAfter, reasoningCountBefore);
    const textEnds = seen.filter(LLMEvent.is.textEnd);
    assert.equal(textEnds.length, 1);
    assert.equal(textEnds[0]?.text, "The color is blue.");
  } finally {
    await ai.dispose();
  }
}

async function testMetaStreamWithoutReasoningSummaryRemainsValid() {
  const ai = AI.make();
  try {
    const model = responses("muse-spark-1.3-contributor");
    const request = new LLMRequest({
      model,
      system: [],
      messages: [Message.user([Message.text("Hello")])],
      tools: [],
      providerOptions: { reasoningEffort: "low", reasoningSummary: "auto" },
    });
    type MetaStreamEvent = Parameters<typeof protocol.stream.step>[1];
    let state = protocol.stream.initial(request);
    const seen: LLMEvent[] = [];
    const feed = async (event: MetaStreamEvent) => {
      const [next, emitted] = await ai.run(protocol.stream.step(state, event));
      state = next;
      seen.push(...(emitted as LLMEvent[]));
      return emitted as LLMEvent[];
    };
    const encryptedSentinel = "gAAAAABopaque-encrypted-reasoning-sentinel-002";

    await feed({
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "message", id: "msg_002", role: "assistant", content: [] },
    });
    await feed({
      type: "response.output_text.delta",
      item_id: "msg_002",
      output_index: 1,
      delta: "Hello ",
    });
    await feed({
      type: "response.output_text.delta",
      item_id: "msg_002",
      output_index: 1,
      delta: "world.",
    });
    await feed({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "message",
        id: "msg_002",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello world." }],
        status: "completed",
      },
    });
    // Real Muse responses still include a reasoning item with an empty
    // summary and opaque encrypted content when no summary is produced.
    const terminalEvent: MetaStreamEvent = {
      type: "response.completed",
      response: {
        id: "resp_002",
        output: [
          {
            type: "reasoning",
            id: "rs_empty",
            summary: [],
            encrypted_content: encryptedSentinel,
          },
          {
            type: "message",
            id: "msg_002",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello world." }],
            status: "completed",
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          total_tokens: 12,
        },
      },
    };
    assert(protocol.stream.terminal, "meta-responses terminal must exist");
    assert.equal(protocol.stream.terminal(terminalEvent), true);
    await feed(terminalEvent);

    // Metadata-only reasoning lifecycle events are valid; what matters is
    // that no nonempty readable reasoning text is produced.
    const readableReasoningTexts = [
      ...seen.filter(LLMEvent.is.reasoningDelta).map((delta) => delta.text),
      ...seen
        .filter(LLMEvent.is.reasoningEnd)
        .map((end) => end.text)
        .filter((text): text is string => typeof text === "string"),
    ].filter((text) => text.length > 0);
    assert.deepEqual(readableReasoningTexts, []);
    const textEnds = seen.filter(LLMEvent.is.textEnd);
    assert.equal(textEnds.length, 1);
    assert.equal(textEnds[0]?.text, "Hello world.");
  } finally {
    await ai.dispose();
  }
}

async function testExistingProviderEndpointIsValidated() {
  const existing: CapturedProvider = {
    info: {
      activation: "enabled",
      name: "Muse Code",
      package: "@opencode/ai/providers/meta/responses",
      settings: { baseURL: "https://api.meta.ai/" },
    },
    models: [],
  };

  await assert.rejects(
    captureRegistration(sourceMusePlugin, existing),
    /Muse requests must use https:\/\/api\.meta\.ai\/v1/,
  );
}

async function testRequestHookAddsMuseAuthAndHeaders(
  plugin: typeof sourceMusePlugin,
) {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-hook-auth-"),
  );
  await writeSubscriptionAuth(configDirectory);
  try {
    await withEnvironment(
      {
        MUSE_API_KEY: "api-key-must-be-ignored",
        META_API_KEY: "meta-key-must-be-ignored",
        XDG_CONFIG_HOME: configDirectory,
      },
      async () => {
        const { hooks } = await captureRegistration(plugin);
        const request = new Request("https://api.meta.ai/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer muse-code-subscription-placeholder",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tools: [
              {
                type: "function",
                name: "shell",
                parameters: { type: "object" },
              },
            ],
          }),
        });
        const event = { request };
        await hooks[0]?.handler(event);
        assert.equal(event.request.redirect, "error");
        const outbound = await event.request.json();
        assert.equal(outbound.tools[0].name, "run_command");

        const responseHook = hooks.find(
          ({ event }) => event === "http.response",
        );
        assert(responseHook);
        const responseEvent = {
          response: Response.json({
            output: [
              {
                type: "function_call",
                name: "run_command",
                call_id: "call-1",
                arguments: '{"command":"printf OK"}',
              },
            ],
          }),
        };
        await responseHook.handler(responseEvent);
        const restored = await responseEvent.response.json();
        assert.equal(restored.output[0].name, "shell");
        assert.equal(restored.output[0].arguments, '{"command":"printf OK"}');

        assert.equal(
          request.headers.get("authorization"),
          `Bearer ${mintedKey}`,
        );
        assert.equal(request.headers.get("user-agent"), museUserAgent);
        assert.equal(request.headers.get("x-client-id"), "tbh:exec");
        assert.match(
          request.headers.get("x-tbh-session-id") ?? "",
          /^[0-9a-f-]{36}$/,
        );
        for (const header of [
          "x-meta-ai-gateway-session-id",
          "x-tbh-thread-id",
          "x-tbh-root-session-id",
        ]) {
          assert.equal(
            request.headers.get(header),
            request.headers.get("x-tbh-session-id"),
          );
        }
        assert.equal(request.headers.get("x-tbh-agent-role"), "main");
        assert.equal(request.headers.get("accept"), "text/event-stream");
        assert.equal(request.headers.get("accept-encoding"), "gzip,deflate,br");
        assert.match(
          request.headers.get("traceparent") ?? "",
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        );
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testSubscriptionAuthReplacesConfiguredApiKey() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-configured-auth-"),
  );
  await writeSubscriptionAuth(configDirectory);
  try {
    await withEnvironment(
      {
        MUSE_API_KEY: "environment-api-key",
        META_API_KEY: "environment-meta-key",
        XDG_CONFIG_HOME: configDirectory,
      },
      async () => {
        const { hooks } = await captureRegistration(sourceMusePlugin);
        const request = new Request("https://api.meta.ai/v1/responses", {
          headers: { authorization: "Bearer provider-config-api-key" },
        });
        await hooks[0]?.handler({ request });
        assert.equal(
          request.headers.get("authorization"),
          `Bearer ${mintedKey}`,
        );
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testContributorModeAndWireModel() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-contributor-"),
  );
  await writeSubscriptionAuth(configDirectory);
  try {
    await withEnvironment(
      { XDG_CONFIG_HOME: configDirectory },
      async () => {
        const { hooks } = await captureRegistration(sourceMusePlugin);
        const httpHook = hooks.find(({ event }) => event === "http.request");
        assert(httpHook);

        for (const [model, wireModel, header] of [
          ["muse-spark-1.3-contributor", "muse-spark-1.3-contributor", "1"],
          ["muse-ember-1.0-contributor", "muse-ember-1.0", "1"],
          ["muse-ember-1.0", "muse-ember-1.0", null],
        ] as const) {
          const event = {
            request: new Request("https://api.meta.ai/v1/responses", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ model, input: [] }),
            }),
          };
          await httpHook.handler(event);
          const outbound = await event.request.json();
          assert.equal(outbound.model, wireModel, `wire model for ${model}`);
          assert.equal(
            event.request.headers.get("x-tbh-contributor-mode"),
            header,
            `contributor header for ${model}`,
          );
        }
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testRequestHookRejectsUntrustedEndpoint() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-untrusted-endpoint-"),
  );
  await writeSubscriptionAuth(configDirectory);
  try {
    await withEnvironment(
      { MUSE_API_KEY: "must-not-leak", XDG_CONFIG_HOME: configDirectory },
      async () => {
        let mintCalls = 0;
        globalThis.fetch = async () => {
          mintCalls++;
          throw new Error("untrusted endpoint must not trigger minting");
        };
        const { hooks } = await captureRegistration(sourceMusePlugin);
        const request = new Request("https://attacker.example/v1/responses");
        const hook = hooks[0];
        assert(hook);
        await assert.rejects(
          async () => hook.handler({ request }),
          /Refusing to send Muse credentials to an unexpected endpoint/,
        );
        assert.equal(request.headers.has("authorization"), false);
        assert.equal(mintCalls, 0);
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testMissingKeyFailsWithoutLeakingCredentials() {
  const configDirectory = await mkdtemp(
    join(testBaseDirectory, "muse-no-key-"),
  );
  try {
    await withEnvironment(
      {
        MUSE_API_KEY: "api-key-must-not-be-used",
        META_API_KEY: undefined,
        XDG_CONFIG_HOME: configDirectory,
      },
      async () => {
        const { hooks } = await captureRegistration(sourceMusePlugin);
        const request = new Request("https://api.meta.ai/v1/responses");
        const hook = hooks[0];
        assert(hook);
        await assert.rejects(
          async () => hook.handler({ request }),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes("No Muse Code subscription login found") &&
            !error.message.includes("api-key-must-not-be-used"),
        );
        assert.equal(request.headers.has("authorization"), false);
      },
    );
  } finally {
    await removeFixtureDirectory(configDirectory);
  }
}

async function testEarlyV2PreviewFailsClearly() {
  await assert.rejects(async () => {
    await sourceMusePlugin.setup({
      catalog: { transform: () => {} },
    } as never);
  }, /older catalog API, whose provider loader is incompatible/);
}

await testAuthResolution();
await testMissingAuthIsSafe();
await testApiKeyOnlyLoginIsNotTreatedAsSubscription();
await testMintFailuresDoNotFallBackOrLeakCredentials();
await testMintRetriesCachesAndReportsCause();
await testV2ProviderRegistration(sourceMusePlugin);
await testV2ProviderRegistration(builtMusePlugin);
await testV2ProviderRegistration(runtimeMusePlugin);
await testToolDescriptionHooksAreMuseScoped(sourceMusePlugin);
await testToolDescriptionHooksAreMuseScoped(builtMusePlugin);
await testToolDescriptionHooksAreMuseScoped(runtimeMusePlugin);
await testExistingProviderModelsArePreserved();
await testCollidingBuiltinOverrideIsPreservedOnce();
await testNativeImageToolEffortAndSummaryRequests(sourceMusePlugin);
await testNativeImageToolEffortAndSummaryRequests(builtMusePlugin);
await testMetaReasoningSummaryStreamProducesReadableReasoning();
await testMetaStreamWithoutReasoningSummaryRemainsValid();
await testExistingProviderEndpointIsValidated();
await testRequestHookAddsMuseAuthAndHeaders(sourceMusePlugin);
await testRequestHookAddsMuseAuthAndHeaders(builtMusePlugin);
await testRequestHookAddsMuseAuthAndHeaders(runtimeMusePlugin);
await testSubscriptionAuthReplacesConfiguredApiKey();
await testContributorModeAndWireModel();
await testRequestHookRejectsUntrustedEndpoint();
await testMissingKeyFailsWithoutLeakingCredentials();
await testEarlyV2PreviewFailsClearly();

console.log("ok - Muse Code OAuth subscription credentials are required");
console.log("ok - V2 provider registration and reasoning variants");
console.log("ok - existing provider and model settings are preserved");
console.log(
  "ok - native image, tool, effort, and reasoning summary request bodies",
);
console.log(
  "ok - Meta reasoning summary stream yields readable reasoning without duplication",
);
console.log("ok - request hook adds credentials only to the Muse endpoint");
console.log("ok - contributor header and Ember wire model override");
console.log("ok - unsupported early V2 preview fails with an upgrade hint");
