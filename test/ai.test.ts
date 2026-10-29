import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
const fail = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status });

describe("askJson provider fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("GROQ_API_KEY", "gk");
    vi.stubEnv("GROQ_MODELS", "qwen-test");
    vi.stubEnv("OPENROUTER_API_KEY", "ok");
    vi.stubEnv("OPENROUTER_MODELS", "free-model:free");
    vi.stubEnv("AI_ROTATION", "fallback");
    for (const [k, v] of Object.entries({
      INTAKE_MAILBOX: "leads@x.com",
      GOOGLE_CLIENT_ID: "a",
      GOOGLE_CLIENT_SECRET: "a",
      GMAIL_REFRESH_TOKEN: "a",
      GMAIL_PUBSUB_TOPIC: "projects/p/topics/t",
      PUBSUB_AUDIENCE: "https://x.com/gmail/push",
      PUBSUB_SERVICE_ACCOUNT: "sa@p.iam.gserviceaccount.com",
      CRM_URL: "https://crm.x.com",
      LEAD_IMPORT_API_KEY: "k",
      ALLOWED_SENDERS: "a@x.com",
      LEAD_GENERATOR_EMAIL: "lg@x.com",
      ALERT_EMAIL: "al@x.com",
    })) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const read = (a: { content?: string }) => ({ ok: true as const, value: a.content });
  const ctx = { messageId: "m1", mailSubject: "s" };

  it("tries Groq first and switches to OpenRouter on a rate limit", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return url.includes("groq") ? fail(429, "Rate limit reached") : ok('{"x":1}');
    }));
    const { askJson } = await import("../src/ai.js");
    const result = await askJson("sys", "user", {}, read, ctx);
    expect(result).toEqual({ ok: true, value: '{"x":1}' });
    expect(calls[0]).toContain("api.groq.com");
    expect(calls[1]).toContain("openrouter.ai");
  });

  it("retries a model with json_object when it rejects json_schema", async () => {
    const formats: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const type = (JSON.parse(String(init.body)) as { response_format: { type: string } }).response_format.type;
      formats.push(type);
      return type === "json_schema" ? fail(400, "This model does not support response format `json_schema`") : ok("{}");
    }));
    const { askJson } = await import("../src/ai.js");
    expect(await askJson("sys", "user", {}, read, ctx)).toMatchObject({ ok: true });
    expect(formats).toEqual(["json_schema", "json_object"]);
  });

  it("throws AiUnavailableError when every model errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fail(429, "Rate limit reached")));
    const { askJson, AiUnavailableError } = await import("../src/ai.js");
    await expect(askJson("sys", "user", {}, read, ctx)).rejects.toBeInstanceOf(AiUnavailableError);
  });
});
