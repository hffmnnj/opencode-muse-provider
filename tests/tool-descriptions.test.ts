import assert from "node:assert/strict";
import { maskMuseToolDescriptions } from "../src/tool-descriptions.js";

const schema = {
  type: "object",
  description: "Original schema fingerprint",
  required: ["command"],
  properties: {
    command: {
      type: "string",
      description: "Original command fingerprint",
      minLength: 1,
      default: { description: "literal default" },
      examples: [{ description: "literal example" }],
      enum: [{ description: "literal enum" }],
      const: { description: "literal const" },
    },
    workdir: { type: "string", description: "Original directory fingerprint" },
    background: { type: "boolean", description: "Original background" },
    unknown: { type: "string", description: "Original unknown" },
    nested: {
      description: "Original nested object",
      properties: {
        path: { type: "string", description: "Original nested path" },
      },
    },
    untouched: { type: "number" },
  },
  patternProperties: { "^x-": { description: "Original pattern" } },
  $defs: { path: { description: "Original definition" } },
  definitions: { name: { description: "Original legacy definition" } },
  dependentSchemas: { code: { description: "Original dependent schema" } },
  dependencies: {
    timeout: { description: "Original schema dependency" },
    command: ["workdir"],
  },
  items: [{ description: "Original tuple item" }, false],
  additionalItems: { description: "Original additional item" },
  additionalProperties: { description: "Original additional property" },
  unevaluatedProperties: { description: "Original unevaluated property" },
  unevaluatedItems: { description: "Original unevaluated item" },
  contains: { description: "Original contains" },
  propertyNames: { description: "Original property name" },
  not: { description: "Original not" },
  if: { description: "Original condition" },
  then: { description: "Original then" },
  else: { description: "Original else" },
  contentSchema: { description: "Original content schema" },
  allOf: [{ description: "Original allOf" }],
  anyOf: [{ description: "Original anyOf" }],
  oneOf: [{ description: "Original oneOf" }],
  prefixItems: [{ description: "Original prefix item" }],
};

const originalSchema = structuredClone(schema);
const expected = structuredClone(schema);
expected.description = "Schema for the declared arguments.";
expected.properties.command.description = "Command to run.";
expected.properties.workdir.description =
  "Directory in which to run the command.";
expected.properties.background.description =
  "Whether to run the operation asynchronously.";
expected.properties.unknown.description = "Value for this parameter.";
expected.properties.nested.description = "Value for this parameter.";
expected.properties.nested.properties.path.description =
  "File or directory path.";
expected.patternProperties["^x-"].description = "Value for this parameter.";
expected.$defs.path.description = "File or directory path.";
expected.definitions.name.description = "Name of the requested item.";
expected.dependentSchemas.code.description = "Code to execute.";
expected.dependencies.timeout.description =
  "Maximum time allowed for the operation.";
expected.items[0] = { description: "Schema for the declared arguments." };
expected.additionalItems.description = "Schema for the declared arguments.";
expected.additionalProperties.description =
  "Schema for the declared arguments.";
expected.unevaluatedProperties.description =
  "Schema for the declared arguments.";
expected.unevaluatedItems.description = "Schema for the declared arguments.";
expected.contains.description = "Schema for the declared arguments.";
expected.propertyNames.description = "Schema for the declared arguments.";
expected.not.description = "Schema for the declared arguments.";
expected.if.description = "Schema for the declared arguments.";
expected.then.description = "Schema for the declared arguments.";
expected.else.description = "Schema for the declared arguments.";
expected.contentSchema.description = "Schema for the declared arguments.";
expected.allOf[0]!.description = "Schema for the declared arguments.";
expected.anyOf[0]!.description = "Schema for the declared arguments.";
expected.oneOf[0]!.description = "Schema for the declared arguments.";
expected.prefixItems[0]!.description = "Schema for the declared arguments.";

const tools = {
  shell: { description: "Original shell fingerprint", input: schema },
  other: {
    description: "Original unknown tool fingerprint",
    input: { items: { description: "Original single item" } },
  },
};

const sharedShell = tools.shell;
maskMuseToolDescriptions(tools);
assert.equal(
  tools.shell.description,
  "Run a command in a chosen directory with an optional execution deadline or asynchronous completion. For background work, wait for its completion event rather than polling.",
);
assert.deepEqual(tools.shell.input, expected);
assert.equal(sharedShell.description, "Original shell fingerprint");
assert.deepEqual(sharedShell.input, originalSchema);
assert.deepEqual(tools.other, {
  description: "Invoke this function using its declared arguments.",
  input: { items: { description: "Schema for the declared arguments." } },
});

const once = structuredClone(tools);
maskMuseToolDescriptions(tools);
assert.deepEqual(tools, once);

const knownNames = [
  "edit",
  "glob",
  "grep",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "todowrite",
  "webfetch",
  "websearch",
  "write",
  "execute",
];
const knownTools = Object.fromEntries(
  knownNames.map((name) => [name, { description: "Original", input: true }]),
);
maskMuseToolDescriptions(knownTools);
for (const name of knownNames) {
  assert.notEqual(knownTools[name]!.description, "Original");
  assert.notEqual(
    knownTools[name]!.description,
    "Invoke this function using its declared arguments.",
  );
}
assert.match(knownTools.subagent!.description, /registered worker/);
assert.match(knownTools.subagent!.description, /model-selection permissions/);

console.log("Tool description masking tests passed.");
