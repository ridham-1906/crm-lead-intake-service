import { z } from "zod";

const list = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const emailList = list.transform((xs) => xs.map((x) => x.toLowerCase())).pipe(z.array(z.email()).min(1));
const email = z.email().transform((e) => e.toLowerCase());
const optionalText = z
  .string()
  .optional()
  .transform((s) => s?.trim() || undefined);
const optionalList = z
  .string()
  .optional()
  .transform((s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  INTAKE_MAILBOX: email,
  COMPANY_NAME: z.string().min(1).default("Excellent Publicity"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GMAIL_REFRESH_TOKEN: z.string().min(1),
  GMAIL_INTAKE_LABEL: z.string().min(1).default("Lead-Intake"),
  GMAIL_PUBSUB_TOPIC: z.string().regex(/^projects\/[^/]+\/topics\/[^/]+$/),
  PUBSUB_AUDIENCE: z.url(),
  PUBSUB_SERVICE_ACCOUNT: z.email(),

  GROQ_API_KEY: optionalText,
  GROQ_MODELS: optionalList,
  OPENROUTER_API_KEY: optionalText,
  OPENROUTER_MODELS: optionalList,
  AI_ROTATION: z.enum(["round-robin", "fallback"]).default("round-robin"),
  AI_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  CRM_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  LEAD_IMPORT_API_KEY: z.string().min(1),

  ALLOWED_SENDERS: emailList,
  LEAD_GENERATOR_EMAIL: email,

  ALERT_EMAIL: emailList,
  ALERT_THROTTLE_MINUTES: z.coerce.number().int().min(0).default(60),

  SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(10),
  DRY_RUN: bool,
}).superRefine((env, ctx) => {
  if (env.GROQ_MODELS.length && !env.GROQ_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["GROQ_API_KEY"], message: "required when GROQ_MODELS is set" });
  }
  if (env.OPENROUTER_MODELS.length && !env.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["OPENROUTER_API_KEY"], message: "required when OPENROUTER_MODELS is set" });
  }
  if (!env.GROQ_MODELS.length && !env.OPENROUTER_MODELS.length) {
    ctx.addIssue({ code: "custom", path: ["GROQ_MODELS"], message: "set GROQ_MODELS and/or OPENROUTER_MODELS" });
  }
});

export type Env = z.infer<typeof schema>;

// Lists every missing or malformed variable; values are never included, since many are secrets.
export class EnvError extends Error {
  constructor(
    readonly missing: string[],
    readonly invalid: string[],
  ) {
    const parts = [
      ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
      ...(invalid.length ? [`invalid: ${invalid.join("; ")}`] : []),
    ];
    super(`Environment is not valid (${parts.join(" | ")}). Compare .env with example.env.`);
    this.name = "EnvError";
  }
}

let cached: Env | undefined;

// Parses process.env once; throws EnvError naming every missing or malformed variable.
export function getEnv(): Env {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "environment");
      const empty = !process.env[key]?.trim();
      if (empty) missing.push(issue.code === "custom" ? `${key} (${issue.message})` : key);
      else invalid.push(`${key} (${issue.message})`);
    }
    throw new EnvError(missing, invalid);
  }
  cached = result.data;
  return cached;
}
