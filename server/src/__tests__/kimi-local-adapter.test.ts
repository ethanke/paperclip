import { describe, expect, it, vi } from "vitest";
import { isKimiUnknownSessionError, parseKimiJsonl } from "@paperclipai/adapter-kimi-local/server";
import { parseKimiStdoutLine } from "@paperclipai/adapter-kimi-local/ui";
import { printKimiStreamEvent } from "@paperclipai/adapter-kimi-local/cli";

describe("kimi_local parser", () => {
  it("extracts session, summary, usage, cost, and terminal error message", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "kimi-session-1", model: "kimi-2.5-pro" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "output_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "kimi-session-1",
        usage: {
          promptTokenCount: 12,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 7,
        },
        total_cost_usd: 0.00123,
        result: "done",
      }),
      JSON.stringify({ type: "error", message: "model access denied" }),
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);
    expect(parsed.sessionId).toBe("kimi-session-1");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 7,
    });
    expect(parsed.costUsd).toBeCloseTo(0.00123, 6);
    expect(parsed.errorMessage).toBe("model access denied");
  });

  it("extracts structured questions", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "output_text", text: "I have a question." },
            {
              type: "question",
              prompt: "Which model?",
              choices: [
                { key: "pro", label: "Kimi Pro", description: "Better" },
                { key: "flash", label: "Kimi Flash" },
              ],
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);
    expect(parsed.summary).toBe("I have a question.");
    expect(parsed.question).toEqual({
      prompt: "Which model?",
      choices: [
        { key: "pro", label: "Kimi Pro", description: "Better" },
        { key: "flash", label: "Kimi Flash", description: undefined },
      ],
    });
  });
});

describe("kimi_local stale session detection", () => {
  it("treats missing session messages as an unknown session error", () => {
    expect(isKimiUnknownSessionError("", "unknown session id abc")).toBe(true);
    expect(isKimiUnknownSessionError("", "checkpoint latest not found")).toBe(true);
  });
});

describe("kimi_local ui stdout parser", () => {
  it("parses assistant, thinking, and result events", () => {
    const ts = "2026-03-08T00:00:00.000Z";

    expect(
      parseKimiStdoutLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "output_text", text: "I checked the repo." },
              { type: "thinking", text: "Reviewing adapter registry" },
              { type: "tool_call", name: "shell", input: { command: "ls -1" } },
              { type: "tool_result", tool_use_id: "tool_1", output: "AGENTS.md\n", status: "ok" },
            ],
          },
        }),
        ts,
      ),
    ).toEqual([
      { kind: "assistant", ts, text: "I checked the repo." },
      { kind: "thinking", ts, text: "Reviewing adapter registry" },
      { kind: "tool_call", ts, name: "shell", input: { command: "ls -1" } },
      { kind: "tool_result", ts, toolUseId: "tool_1", content: "AGENTS.md\n", isError: false },
    ]);

    expect(
      parseKimiStdoutLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "Done",
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            cachedContentTokenCount: 2,
          },
          total_cost_usd: 0.00042,
          is_error: false,
        }),
        ts,
      ),
    ).toEqual([
      {
        kind: "result",
        ts,
        text: "Done",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.00042,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
  });
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("kimi_local cli formatter", () => {
  it("prints init, assistant, result, and error events", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let joined = "";

    try {
      printKimiStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", session_id: "kimi-session-1", model: "kimi-2.5-pro" }),
        false,
      );
      printKimiStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "output_text", text: "hello" }] },
        }),
        false,
      );
      printKimiStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            cachedContentTokenCount: 2,
          },
          total_cost_usd: 0.00042,
        }),
        false,
      );
      printKimiStreamEvent(
        JSON.stringify({ type: "error", message: "boom" }),
        false,
      );
      joined = spy.mock.calls.map((call) => stripAnsi(call.join(" "))).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(joined).toContain("Kimi init");
    expect(joined).toContain("assistant: hello");
    expect(joined).toContain("tokens: in=10 out=5 cached=2 cost=$0.000420");
    expect(joined).toContain("error: boom");
  });
});
