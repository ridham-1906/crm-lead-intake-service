import { alert } from "./alert.js";
import { getEnv } from "./env.js";
import { errInfo, log } from "./log.js";

export type Provider = "groq" | "openrouter";
export type Target = { provider: Provider; model: string };
export type Rotation = "round-robin" | "fallback";

// Both speak the OpenAI chat-completions format.
const ENDPOINTS: Record<Provider, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Every configured model failed at the API level: the mail is left for the next sweep.
export class AiUnavailableError extends Error {}

class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cooldownMs: number,
  ) {
    super(message);
  }
}

type ChatResponse = {
  error?: { message?: string; code?: number | string };
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

// usage.cached shows how many input tokens the provider served from its prompt cache.
export type Answer = {
  content: string | undefined;
  finishReason: string | undefined;
  usage?: { input?: number; output?: number; cached?: number };
};
export type ReadResult<T> = { ok: true; value: T } | { ok: false; unusable: string };

let turn = 0;
const coolingUntil = new Map<string, number>();
// Models that rejected json_schema; they get json_object plus the schema in the prompt instead.
const noJsonSchema = new Set<string>();

const keyOf = (t: Target) => `${t.provider}:${t.model}`;

function rotate<T>(items: T[], start: number): T[] {
  if (!items.length) return items;
  const s = start % items.length;
  return [...items.slice(s), ...items.slice(0, s)];
}

// Groq models first, then OpenRouter; each group rotated per call (round-robin) or in listed order (fallback).
export function modelOrder(groq: string[], openrouter: string[], rotation: Rotation, now = Date.now()): Target[] {
  const start = rotation === "round-robin" ? turn++ : 0;
  const targets: Target[] = [
    ...rotate(groq, start).map((model) => ({ provider: "groq" as const, model })),
    ...rotate(openrouter, start).map((model) => ({ provider: "openrouter" as const, model })),
  ];
  return targets.filter((t) => (coolingUntil.get(keyOf(t)) ?? 0) <= now);
}

function cooldownFrom(res: Response, fallbackMs: number): number {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (reset > Date.now()) return Math.min(reset - Date.now(), MAX_COOLDOWN_MS);
  return fallbackMs;
}

async function callModel(target: Target, system: string, user: string, schema: Record<string, unknown>): Promise<Answer> {
  const env = getEnv();
  const cooldownMs = env.AI_COOLDOWN_SECONDS * 1000;
  const openrouter = target.provider === "openrouter";
  const useSchema = !noJsonSchema.has(keyOf(target));

  const body = {
    model: target.model,
    messages: [
      {
        role: "system",
        content: useSchema ? system : `${system}\n\nReply with only a JSON object matching this JSON schema:\n${JSON.stringify(schema)}`,
      },
      { role: "user", content: user },
    ],
    response_format: useSchema
      ? { type: "json_schema", json_schema: { name: "lead_extraction", strict: openrouter, schema } }
      : { type: "json_object" },
    max_tokens: 8192,
    // OpenRouter only: route to providers that honour response_format.
    ...(openrouter ? { provider: { require_parameters: true } } : {}),
  };

  let res: Response;
  try {
    res = await fetch(ENDPOINTS[target.provider], {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouter ? env.OPENROUTER_API_KEY : env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
        ...(openrouter ? { "X-Title": "ep-lead-intake" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new ModelError(`request failed: ${(err as Error).message}`, 0, cooldownMs);
  }

  const data = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok || data.error) {
    const message = data.error?.message ?? "no error message";
    if (useSchema && res.status === 400 && /response.?format|json.?schema/i.test(message)) {
      noJsonSchema.add(keyOf(target));
      log.warn({ model: keyOf(target) }, "model rejected json_schema; using json_object");
      return callModel(target, system, user, schema);
    }
    // OpenRouter can report an upstream error inside a 200 body.
    const status = res.ok ? (typeof data.error?.code === "number" ? data.error.code : 502) : res.status;
    throw new ModelError(`${status}: ${message}`, status, cooldownFrom(res, cooldownMs));
  }
  const choice = data.choices?.[0];
  const usage = {
    input: data.usage?.prompt_tokens,
    output: data.usage?.completion_tokens,
    cached: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
  return { content: choice?.message?.content ?? undefined, finishReason: choice?.finish_reason, usage };
}

// Asks each available model in order until one gives a usable answer. Throws only when every model errored.
export async function askJson<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  read: (answer: Answer) => ReadResult<T>,
  ctx: { messageId: string; mailSubject: string },
): Promise<ReadResult<T>> {
  const env = getEnv();
  const targets = modelOrder(env.GROQ_MODELS, env.OPENROUTER_MODELS, env.AI_ROTATION);
  if (!targets.length) throw new AiUnavailableError("every AI model is cooling down after rate limits or errors");

  const failures: string[] = [];
  let unusable: string | undefined;

  for (const target of targets) {
    const model = keyOf(target);
    try {
      const answer = await callModel(target, system, user, schema);
      const result = read(answer);
      if (result.ok) {
        log.info({ messageId: ctx.messageId, model, tokens: answer.usage }, "AI answered");
        return result;
      }
      unusable = result.unusable;
      failures.push(`${model}: ${result.unusable}`);
      log.warn({ messageId: ctx.messageId, model, reason: result.unusable }, "AI answer unusable; trying next");
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      coolingUntil.set(model, Date.now() + err.cooldownMs);
      failures.push(`${model}: ${err.message}`);
      log.warn({ messageId: ctx.messageId, model, err: errInfo(err) }, "AI model failed; trying next");
      // Rate limits are expected on free tiers; anything else (bad key, model removed) is worth an email.
      if (err.status !== 429) {
        await alert({ stage: "AI", summary: `model ${model} failing`, error: err, ...ctx });
      }
    }
  }

  if (unusable) return { ok: false, unusable };
  throw new AiUnavailableError(`all AI models failed: ${failures.join(" | ")}`);
}
