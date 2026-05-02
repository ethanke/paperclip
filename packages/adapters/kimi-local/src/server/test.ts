import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  asStringArray,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_KIMI_LOCAL_MODEL } from "../index.js";
import { detectKimiAuthRequired, detectKimiQuotaExhausted, parseKimiJsonl } from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "kimi");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `kimi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "kimi_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "kimi_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "kimi_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "kimi_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "kimi_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configKimiApiKey = env.KIMI_API_KEY;
  const hostKimiApiKey = targetIsRemote ? undefined : process.env.KIMI_API_KEY;
  const configMoonshotApiKey = env.MOONSHOT_API_KEY;
  const hostMoonshotApiKey = targetIsRemote ? undefined : process.env.MOONSHOT_API_KEY;
  if (
    isNonEmpty(configKimiApiKey) ||
    isNonEmpty(hostKimiApiKey) ||
    isNonEmpty(configMoonshotApiKey) ||
    isNonEmpty(hostMoonshotApiKey)
  ) {
    const source = isNonEmpty(configKimiApiKey) || isNonEmpty(configMoonshotApiKey)
      ? "adapter config env"
      : "server environment";
    checks.push({
      code: "kimi_api_key_present",
      level: "info",
      message: "Kimi API credentials are set for CLI authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "kimi_api_key_missing",
      level: "info",
      message: "No explicit API key detected. Kimi CLI may still authenticate via local `/login` configuration.",
      hint: "If the hello probe fails with an auth error, set KIMI_API_KEY or MOONSHOT_API_KEY in adapter env, or run `/login` in `kimi`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "kimi_cwd_invalid" && check.code !== "kimi_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "kimi")) {
      checks.push({
        code: "kimi_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `kimi`.",
        detail: command,
        hint: "Use the `kimi` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_KIMI_LOCAL_MODEL).trim();
      const helloProbeTimeoutSec = Math.max(1, asNumber(config.helloProbeTimeoutSec, 10));
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--print", "--output-format", "stream-json"];
      if (model && model !== DEFAULT_KIMI_LOCAL_MODEL) args.push("--model", model);
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("Respond with hello.");

      const probe = await runAdapterExecutionTargetProcess(
        runId,
        target,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: helloProbeTimeoutSec,
          graceSec: 5,
          onLog: async () => { },
        },
      );
      const parsed = parseKimiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authMeta = detectKimiAuthRequired({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
      const quotaMeta = detectKimiQuotaExhausted({
        parsed: parsed.resultEvent,
        stdout: probe.stdout,
        stderr: probe.stderr,
      });

      if (quotaMeta.exhausted) {
        checks.push({
          code: "kimi_hello_probe_quota_exhausted",
          level: "warn",
          message: probe.timedOut
            ? "Kimi CLI is retrying after quota exhaustion."
            : "Kimi CLI authentication is configured, but the current account or API key is over quota.",
          ...(detail ? { detail } : {}),
          hint: "The configured Kimi/Moonshot account or API key is over quota. Check the Moonshot AI console usage/billing page, then retry the probe.",
        });
      } else if (probe.timedOut) {
        checks.push({
          code: "kimi_hello_probe_timed_out",
          level: "warn",
          message: "Kimi hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Kimi can run `Respond with hello.` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "kimi_hello_probe_passed" : "kimi_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Kimi hello probe succeeded."
            : "Kimi probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
              hint: "Try `kimi --output-format json \"Respond with hello.\"` manually to inspect full output.",
            }),
        });
      } else if (authMeta.requiresAuth) {
        checks.push({
          code: "kimi_hello_probe_auth_required",
          level: "warn",
          message: "Kimi CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `/login` in `kimi` or configure KIMI_API_KEY / MOONSHOT_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "kimi_hello_probe_failed",
          level: "error",
          message: "Kimi hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `kimi --output-format json \"Respond with hello.\"` manually in this working directory to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
