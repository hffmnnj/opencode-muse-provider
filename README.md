![Muse Code provider for OpenCode, featuring Meta's logo and the Spark, Ember and Wonder model families](assets/banner.png)

# Muse Code provider for OpenCode V2

This package is an OpenCode V2 plugin for Muse Code. It registers Muse Spark,
Muse Ember and Muse Wonder models on Meta's Responses API using OpenCode's native Meta Responses provider.
Request construction and streaming are delegated to the native V2 provider.

## Install

Add the package to the V2 plugin list in `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-muse-provider"],
  "model": "muse/muse-spark-1.3-contributor",
}
```

For a local checkout during development, use its absolute path in `plugins`
instead of the published package name. OpenCode V1 plugin implementations are
not supported by this package. The plugin requires the V2 provider-transform
API. Early V2 previews that expose only the catalog-transform API are
incompatible with the native Meta Responses package and will fail with an
upgrade hint rather than registering an unusable model.

In the OpenCode V2 interface, run `/models` and select a `muse/...` entry. The
`model` setting above sets the default for new sessions; it does not switch an
already-open session. The model catalog is location-specific, so make sure the
plugin is enabled in the configuration used by the OpenCode V2 server serving
that project.

## Troubleshooting model visibility

V2 registers these models at runtime, so they do not need entries under
`providers` in `opencode.json`. Open the V2 model selector with `/models` and
choose a `muse/...` entry such as `muse/muse-spark-1.3-contributor`,
`muse/muse-ember-1.0`, `muse/muse-ember-1.0-contributor`,
`muse/muse-wonder-1.0`, `muse/muse-wonder-1.0-contributor`,
`muse/muse-wonder-full-1.0`, or `muse/muse-wonder-full-1.0-contributor`.
Registering a model does not change the configured default. If your machine has separate V1 and V2
executables, launch V2; this plugin is intentionally V2-only.

## Models and reasoning

The plugin registers eight subscription models: `muse-spark-1.2-contributor`,
`muse-spark-1.3-contributor`, `muse-ember-1.0`, `muse-ember-1.0-contributor`,
`muse-wonder-1.0`,
`muse-wonder-1.0-contributor`, `muse-wonder-full-1.0`, and
`muse-wonder-full-1.0-contributor`. All eight advertise text and image input plus text output with tool use.
Image support means image input natively (PNG/JPEG/GIF/WebP via OpenCode attachments → input_image);
it is not image generation. Only text plus image input and text output are advertised.
Structured outputs are not advertised because their behavior has not been
verified against the Muse endpoint. Meta documents parallel tool calling, but
the plugin does not claim end-to-end parallel tool handling by OpenCode.
Spark and Ember retain the plugin's configured limits (1,048,576-token context window and 131,072-token output limit).
The public Muse Ember docs advertise a 524,288-token maximum output, but the effective Muse Code subscription-catalog
limits for `muse-ember-1.0` were not verified when it was added; the plugin conservatively mirrors the Spark cap.
Meta's [model documentation](https://dev.meta.ai/docs/models) describes the model families and subscription availability.
Both Ember IDs were exercised live with Minimal reasoning through `muse exec` before registration.
The Wonder limits (1,007,997-token context and 128,000-token output) are the effective
Muse Code CLI catalog limits for these subscription IDs; they are not claimed as a separate
undocumented 131,072-token Wonder API ceiling. The public model docs do not list the
Contributor subscription IDs, so the installed Muse Code catalog is the source for those
subscription IDs and their effective limits (verified with Muse Code 1.4.6's provider catalog).
Muse Wonder Full 1.0 models require a Power or Maximum plan. Contributor models
(`muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`,
`muse-ember-1.0-contributor`,
`muse-wonder-1.0-contributor`, and `muse-wonder-full-1.0-contributor`) carry the catalog
data-use notice: your content, including inter-session messages, may be used for product improvement.
The public model docs describe Muse Ember as Standard-mode only with no Contributor variant; the
`muse-ember-1.0-contributor` subscription ID is not listed there but was verified working with
`muse exec` on a Muse Code subscription (Muse Code 1.4.14) on 2026-11-09, the same way the Spark
Contributor IDs are catalog subscription variants.
Select a reasoning variant with `#variant`, for example:

```text
muse/muse-spark-1.3-contributor#high
muse/muse-wonder-1.0#high
```

Available selectors are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra` for all families. The default is `low` for Spark and Ember and `medium` for Wonder
when no variant is selected.
The Meta Responses API does not support disabling reasoning, so `none` maps to the API's minimum
`minimal` effort for all models. Spark Contributor `max`/`ultra` map to `xhigh`, the highest documented
Contributor effort, while Ember and Wonder `max`/`ultra` map to `max`. See Meta's [reasoning documentation](https://dev.meta.ai/docs/reasoning).

The plugin requests human-readable reasoning summaries automatically
(`reasoning.summary: "auto"`) for its registered models. Summaries are separate from the
model's private chain of thought and encrypted replay data; only the summary
text, when returned, is surfaced. Muse may legitimately omit a summary for a
turn, so missing summary text does not by itself mean reasoning is disabled.
Existing user-defined model overrides are preserved. See Meta's
[reasoning summaries documentation](https://dev.meta.ai/docs/reasoning#summaries).

## Tool description compatibility

For Muse requests only, the plugin replaces tool help and nested JSON Schema
description metadata with neutral alternatives. This applies to agent,
compaction, and transient generation requests. Internal tool names, argument
fields, validation rules, literal schema data, permissions, and executors are unchanged.
Other providers retain their original descriptions.

The Meta endpoint also rejects a standalone function named `shell` or `bash`
with `client_attestation_denied`. For Muse only, the adapter advertises OpenCode's
`shell` as `run_command` on the wire and restores returned calls to `shell`
before native dispatch. Tool history and explicit tool selectors use the same
reversible alias; arguments and permissions are not translated or bypassed.
The wire name `run_command` is reserved for this adapter, so a conflicting
custom tool fails explicitly rather than being dispatched to the wrong executor.

Description masking is not client attestation. A rejection does not by itself
mean the OAuth login expired. The installed official SDK drives full Muse Code
agent sessions rather than providing a drop-in raw-model transport for OpenCode tools.

## Credentials

Sign in with the Muse Code subscription using `muse login`. At request time, the
plugin reads the Muse CLI credential file at
`${MUSE_AUTH_PATH:-${XDG_CONFIG_HOME:-~/.config}/muse/auth.json}` and requires an
OAuth login (`providers.meta.mechanism: "oauth"`, with `access_token` present).
Like Muse Code, it exchanges that OAuth bearer at
`https://api.meta.ai/muse-code/key` before sending a model request. Only the
returned active-subscription `api_key` is sent to the Responses API; the OAuth
access token is never used as the model credential. The cached `api_key` in the
CLI profile is not used as a fallback, and the plugin does not rewrite that file.

To avoid silently switching to separate API-key billing, the plugin ignores
`MUSE_API_KEY`, `META_API_KEY`, and provider-configured API keys, replacing any
resolved authorization header with the credential from the Muse CLI OAuth
profile. If no OAuth login is available, it fails with instructions to run
`muse login`.

Requests use the client identity captured from Muse Code 1.4.14-R7309.1,
including its user-agent, client ID, matching session/gateway/thread IDs, agent
role, and streaming acceptance headers. Dynamic identifiers are generated for
the adapter's requests; this does not make OpenCode a full Muse Code agent.
Mint and model destinations remain restricted to the trusted Meta endpoints;
redirects from the mint endpoint are refused. An expired OAuth login, inactive
subscription, or mint failure never silently falls back to API-key billing.

The mint call is retried up to three times for transient failures (network
errors such as `ECONNRESET`, timeouts, HTTP 408/425/429/5xx), and the final error
names the sanitized cause, for example `(ECONNRESET)` or `(HTTP 503)`. A minted
key is cached in memory for five minutes and shared by concurrent sessions; the
cache is dropped when the model API answers 401 or 403.

The native Meta Responses adapter requires an API-key value during request
construction. The plugin supplies a non-secret placeholder to satisfy that
check, then replaces it with the Muse Code subscription credential in the
provider-scoped HTTP hook before dispatch. The placeholder is never intended
to be sent to Meta.

The request is sent to `https://api.meta.ai/v1/responses`. This version does
not expose a custom endpoint setting. Do not use an HTTP interception proxy or
other untrusted network endpoint with a Muse credential.

## Development

Requires Node.js 18.17 or newer. Building the local runtime bundle also requires Bun.

```bash
npm install
npm test
npm run typecheck
npm run format:check
```

`npm test` builds first so tests cannot accidentally import stale `dist`
output. The plugin itself uses the V2 API from `@opencode/plugin`.

The build also produces a self-contained local runtime at
`dist/muse-code-1.4.14-r4/server.js`. To activate this build in a long-running
OpenCode server without reusing previously imported modules, register the
`dist/muse-code-1.4.14-r4` directory as the local plugin. OpenCode requires a
directory here, not the path to `server.js`. A configuration reload does not
invalidate JavaScript's module cache; use a new runtime directory for a later
code revision that must be activated in the same server process.
