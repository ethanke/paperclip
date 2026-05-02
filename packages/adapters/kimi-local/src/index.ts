import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "kimi_local";
export const label = "Kimi CLI (local)";

export const DEFAULT_KIMI_LOCAL_MODEL = "auto";

export const models = [
  { id: DEFAULT_KIMI_LOCAL_MODEL, label: "Auto" },
  { id: "kimi-k2", label: "Kimi K2" },
  { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo Preview" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use the default Kimi CLI model as the budget Kimi lane while preserving the primary model.",
    adapterConfig: {
      model: DEFAULT_KIMI_LOCAL_MODEL,
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# kimi_local agent configuration

Adapter: kimi_local

Use when:
- You want Paperclip to run the Kimi CLI locally on the host machine
- You want Kimi chat sessions resumed across heartbeats with --resume
- You want Paperclip skills injected locally without polluting the global environment

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Kimi CLI is not installed on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- model (string, optional): Kimi model id. Defaults to auto.
- command (string, optional): defaults to "kimi"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`kimi --print --output-format stream-json <prompt>\` for non-interactive execution.
- Sessions resume with --resume when stored session cwd matches the current cwd.
- Authentication can use KIMI_API_KEY, MOONSHOT_API_KEY, or local Kimi CLI /login configuration.
`;
