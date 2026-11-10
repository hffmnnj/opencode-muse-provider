import { Model, Plugin, Provider } from "@opencode/plugin";
import { resolveMuseSubscriptionKey } from "./auth.js";
import { maskMuseToolDescriptions } from "./tool-descriptions.js";
import {
  prepareMuseToolRequest,
  restoreMuseToolResponse,
} from "./tool-alias.js";
import {
  MUSE_BASE_URL,
  setMuseRequestHeaders,
  validateMuseBaseURL,
  validateMuseRequestURL,
} from "./request.js";

const PROVIDER_ID = Provider.ID.make("muse");
const META_RESPONSES_PACKAGE = "@opencode/ai/providers/meta/responses";
const AUTH_PLACEHOLDER = "muse-code-subscription-placeholder";

const SPARK_LIMIT = { context: 1_048_576, output: 131_072 };
const WONDER_LIMIT = { context: 1_007_997, output: 128_000 };

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type MaxReasoningEffort = "xhigh" | "max";

interface MuseModelSpec {
  id: string;
  name: string;
  limit: { context: number; output: number };
  defaultEffort: ReasoningEffort;
  maxEffort: MaxReasoningEffort;
}

const MODELS: readonly MuseModelSpec[] = [
  {
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    limit: SPARK_LIMIT,
    defaultEffort: "low",
    maxEffort: "xhigh",
  },
  {
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    limit: SPARK_LIMIT,
    defaultEffort: "low",
    maxEffort: "xhigh",
  },
  {
    id: "muse-wonder-1.0",
    name: "Muse Wonder 1.0",
    limit: WONDER_LIMIT,
    defaultEffort: "medium",
    maxEffort: "max",
  },
  {
    id: "muse-wonder-1.0-contributor",
    name: "Muse Wonder 1.0 Contributor",
    limit: WONDER_LIMIT,
    defaultEffort: "medium",
    maxEffort: "max",
  },
  {
    id: "muse-wonder-full-1.0",
    name: "Muse Wonder Full 1.0",
    limit: WONDER_LIMIT,
    defaultEffort: "medium",
    maxEffort: "max",
  },
  {
    id: "muse-wonder-full-1.0-contributor",
    name: "Muse Wonder Full 1.0 Contributor",
    limit: WONDER_LIMIT,
    defaultEffort: "medium",
    maxEffort: "max",
  },
];

function reasoningVariantsFor(maxEffort: MaxReasoningEffort) {
  return [
    { id: "none", effort: "minimal" },
    { id: "minimal", effort: "minimal" },
    { id: "low", effort: "low" },
    { id: "medium", effort: "medium" },
    { id: "high", effort: "high" },
    { id: "xhigh", effort: "xhigh" },
    { id: "max", effort: maxEffort },
    { id: "ultra", effort: maxEffort },
  ] as const;
}

const models = MODELS.map(({ id, name, limit, defaultEffort, maxEffort }) => ({
  ...Model.Info.default(PROVIDER_ID, Model.ID.make(id)),
  name,
  limit,
  capabilities: {
    tools: true,
    input: ["text", "image"],
    output: ["text"],
  },
  settings: {
    reasoningEffort: defaultEffort,
    // reasoningEffort alone uses private reasoning tokens; summary requests the readable summary.
    reasoningSummary: "auto",
  },
  variants: reasoningVariantsFor(maxEffort).map(({ id, effort }) => ({
    id: Model.VariantID.make(id),
    settings: { reasoningEffort: effort },
  })),
}));

async function addMuseRequestHeaders(request: Request): Promise<void> {
  validateMuseRequestURL(request.url);

  const subscriptionKey = await resolveMuseSubscriptionKey({
    signal: request.signal,
  });
  if (!subscriptionKey) {
    throw new Error(
      "No Muse Code subscription login found. Run `muse login` and ensure its OAuth credentials are available in the Muse auth file.",
    );
  }

  // Replace any API-key auth OpenCode may have resolved from environment or
  // provider config: this integration is specifically for Muse Code login.
  setMuseRequestHeaders(request.headers, subscriptionKey);
}

function providerDefinition() {
  return {
    info: {
      ...Provider.Info.empty(PROVIDER_ID),
      name: "Muse Code",
      activation: "enabled" as const,
      package: META_RESPONSES_PACKAGE,
      // The native Meta adapter requires an API key before it builds a request.
      // The HTTP hook replaces this non-secret marker with the Muse CLI
      // subscription key immediately before dispatch.
      settings: { baseURL: MUSE_BASE_URL, apiKey: AUTH_PLACEHOLDER },
    },
    models,
  };
}

async function registerProvider(ctx: unknown): Promise<void> {
  const domains = ctx as {
    provider?: {
      transform?: (
        callback: (editor: {
          get(id: string):
            | {
                provider: {
                  package: string;
                  settings?: Record<string, unknown>;
                };
                models: ReadonlyMap<string, unknown>;
              }
            | undefined;
          update(
            providerID: string,
            update: (provider: { settings?: Record<string, unknown> }) => void,
          ): void;
          add(definition: ReturnType<typeof providerDefinition>): void;
          models: {
            set(providerID: string, models: readonly unknown[]): void;
          };
        }) => void,
      ) => Promise<unknown>;
    };
  };

  if (typeof domains.provider?.transform === "function") {
    await domains.provider.transform((editor) => {
      const existing = editor.get(PROVIDER_ID);
      if (!existing) {
        editor.add(providerDefinition());
        return;
      }

      if (existing.provider.package !== META_RESPONSES_PACKAGE) {
        throw new Error(
          'The "muse" provider is configured with a different runtime package. Use "@opencode/ai/providers/meta/responses" or remove the conflicting provider definition.',
        );
      }

      const baseURL = existing.provider.settings?.baseURL;
      if (typeof baseURL === "string") validateMuseBaseURL(baseURL);

      editor.update(PROVIDER_ID, (provider) => {
        provider.settings = {
          ...provider.settings,
          apiKey: AUTH_PLACEHOLDER,
        };
      });

      const modelIDs = new Set(existing.models.keys());
      const additions = models.filter(({ id }) => !modelIDs.has(String(id)));
      if (additions.length > 0) {
        editor.models.set(PROVIDER_ID, [
          ...existing.models.values(),
          ...additions,
        ]);
      }
    });
    return;
  }

  throw new Error(
    "Muse Code requires the OpenCode V2 provider-transform API (ctx.provider.transform). The installed V2 preview exposes only the older catalog API, whose provider loader is incompatible with the Meta Responses adapter. Upgrade OpenCode V2 before enabling this plugin.",
  );
}

export default Plugin.define({
  id: "muse",
  async setup(ctx) {
    await registerProvider(ctx);

    await ctx.session.hook(
      "http.request",
      async (event) => {
        await addMuseRequestHeaders(event.request);
        event.request = new Request(
          await prepareMuseToolRequest(event.request),
          {
            redirect: "error",
          },
        );
      },
      { providerID: PROVIDER_ID },
    );

    for (const kind of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(
        kind,
        (event) => maskMuseToolDescriptions(event.tools),
        { providerID: PROVIDER_ID },
      );
    }

    await ctx.session.hook(
      "http.response",
      async (event) => {
        event.response = await restoreMuseToolResponse(event.response);
      },
      { providerID: PROVIDER_ID },
    );
  },
});
