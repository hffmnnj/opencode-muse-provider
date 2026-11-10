export interface MuseDescribedTool {
  description: string;
  input: unknown;
}

export type MuseToolMap = Record<string, MuseDescribedTool>;

const toolDescriptions: Readonly<Record<string, string>> = {
  edit: "Apply specified changes to an existing file.",
  glob: "Find file paths matching a glob pattern.",
  grep: "Find matching text in files and report its location.",
  question: "Ask the user to choose or provide an answer.",
  read: "Read a file or directory, optionally selecting a range.",
  shell:
    "Run a command in a chosen directory with an optional execution deadline or asynchronous completion. For background work, wait for its completion event rather than polling.",
  skill: "Load instructions for a named available skill.",
  subagent:
    "Assign a task to an available registered worker, subject to current model-selection permissions.",
  todowrite: "Create or update the current task list.",
  webfetch: "Retrieve content from an HTTP or HTTPS address.",
  websearch: "Search the web for relevant information.",
  write: "Write content to a file.",
  execute: "Run JavaScript to compose available tool calls and their results.",
};

const parameterDescriptions: Readonly<Record<string, string>> = {
  command: "Command to run.",
  workdir: "Directory in which to run the command.",
  timeout: "Maximum time allowed for the operation.",
  background: "Whether to run the operation asynchronously.",
  path: "File or directory path.",
  offset: "Starting position for the requested range.",
  limit: "Maximum number of results or items.",
  pattern: "Pattern used to match results.",
  name: "Name of the requested item.",
  code: "Code to execute.",
  description: "Description of the item.",
};

const schemaMaps = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
] as const;

const singleSchemas = [
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
] as const;

const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mappedDescription(
  descriptions: Readonly<Record<string, string>>,
  name: string,
  fallback: string,
): string {
  return Object.hasOwn(descriptions, name) ? descriptions[name]! : fallback;
}

function maskSchema(schema: unknown, parameterName?: string): void {
  if (!isObject(schema)) return;

  if (typeof schema.description === "string") {
    schema.description = parameterName
      ? mappedDescription(
          parameterDescriptions,
          parameterName,
          "Value for this parameter.",
        )
      : "Schema for the declared arguments.";
  }

  for (const keyword of schemaMaps) {
    const entries = schema[keyword];
    if (!isObject(entries)) continue;
    for (const [name, child] of Object.entries(entries)) {
      maskSchema(child, name);
    }
  }

  for (const keyword of singleSchemas) {
    const child = schema[keyword];
    if (keyword === "items" && Array.isArray(child)) {
      for (const item of child) maskSchema(item);
    } else {
      maskSchema(child);
    }
  }

  for (const keyword of schemaArrays) {
    const children = schema[keyword];
    if (Array.isArray(children)) {
      for (const child of children) maskSchema(child);
    }
  }
}

export function maskMuseToolDescriptions(tools: MuseToolMap): void {
  for (const [name, tool] of Object.entries(tools)) {
    const input = structuredClone(tool.input);
    maskSchema(input);
    tools[name] = {
      ...tool,
      description: mappedDescription(
        toolDescriptions,
        name,
        "Invoke this function using its declared arguments.",
      ),
      input,
    };
  }
}
