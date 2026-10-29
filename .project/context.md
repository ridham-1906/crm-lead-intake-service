# ep-lead-intake: context

Standalone Node 22 / TypeScript (ESM) service that turns inquiry emails to a configurable mailbox (`INTAKE_MAILBOX`) into EP CRM leads. Talks to the CRM only over HTTP. Original design: [lead-intake-service-plan.md](../lead-intake-service-plan.md). User-facing usage/setup spec: [docs/SPEC.md](../docs/SPEC.md). All env vars: [example.env](../example.env).

## Data flow

Gmail filter labels allowed senders' mail `Lead-Intake` → `users.watch` (that label) → Pub/Sub push → `POST /gmail/push` (OIDC verified, 204 immediately) → `sweep()` searches `label:Lead-Intake -label:CRM-Done -label:CRM-Review -label:CRM-Ignored` → `enqueue()` → single worker drains the FIFO queue one message at a time (`src/queue.ts`). Sweeps also run on boot and every `SWEEP_INTERVAL_MINUTES`; the Gmail watch is renewed daily.

Per message (`src/process.ts`): fetch + parse → skip if already outcome-labelled → allowlist + Gmail `Authentication-Results` (DMARC, or SPF+DKIM) → CRM reference (cached 5 min) → AI draft via OpenRouter (`src/extract.ts`) → code validation → CRM create → reply / forward → outcome label **last**.

## AI (Groq first, then OpenRouter)

- `src/ai.ts` owns providers and model switching; `src/extract.ts` owns the prompt, schema and answer parsing. Both providers via plain fetch to OpenAI-compatible chat completions.
- Order per call: all `GROQ_MODELS`, then all `OPENROUTER_MODELS`; `AI_ROTATION` (`round-robin` / `fallback`) rotates within each provider. Models in cooldown are skipped. Either provider may be unset; at least one must be configured.
- API error → model cooled down (`Retry-After` / `x-ratelimit-reset` / `AI_COOLDOWN_SECONDS`), try next. Unusable output → try next, no cooldown. All unusable → review. All errored/cooling → `AiUnavailableError` (mail retried, alert sent). Non-429 single-model errors alert.
- Asks for strict `json_schema` (OpenRouter strict, Groq best-effort). A 400 rejecting json_schema switches that model to `json_object` + schema in prompt (remembered in memory). Replies are parsed by taking the outermost JSON object after stripping `<think>` blocks, then zod-validated.
- OpenRouter-only extras: `provider.require_parameters`, `X-Title`. Free tiers may log prompts (client PII); OpenRouter's free daily cap is per account.

## Rules that hold everywhere

- No database: outcome labels are the state. Unlabelled mail is retried by the next sweep; a retry after a create gets a CRM 409 and lands in review.
- Transient failures (CRM 401/5xx/network, all AI models down, Gmail errors) throw, leave the mail unlabelled and trigger an alert. Content problems go to review.
- Alerts (`src/alert.ts`) go to `ALERT_EMAIL` via the intake mailbox, throttled per stage+error for `ALERT_THROTTLE_MINUTES`. Single-model 429s don't alert; other single-model errors do.
- Assignment: salespeople = To: recipients who are CRM users, minus sender, `INTAKE_MAILBOX` and `LEAD_GENERATOR_EMAIL` (`recipientAssignees`, in code). They are given to the AI as `<assignees>` and override its pick. If none, the AI maps owners named in the text. Cc never assigns.
- Mobiles: any country. Dial code taken from the `+code` written before the number in the mail, else the AI's, else +91; +91 numbers must be 10 digits starting 6-9, others must fit E.164 (≤ 15 digits).
- Startup (`src/server.ts`) runs named steps (environment → Gmail sign-in → labels → HTTP listen), printing `startup: <step> ok` to the console only (not Loki, no config values); any failure logs `startup failed at "<step>"` with a `hint` and exits 1. CRM reference and Gmail watch are non-fatal checks. `getEnv()` throws `EnvError` with separate `missing` / `invalid` lists (never values). Final `ep-lead-intake started on port …` console line has no config values.
- Boot asserts the Gmail token's account equals `INTAKE_MAILBOX`. `COMPANY_NAME` feeds the prompt. The intake mailbox and allowed senders' domains are treated as internal in validation.
- Single replica only (in-memory queue).
- `DRY_RUN=true`: no CRM call, no labels, no replies/forwards; alerts still sent; processed ids remembered in memory.
- Logs: pino to stdout, plus Grafana Loki via pino-loki when `LOKI_URL` is set (same stack and label scheme as ep-crm: `app=ep-lead-intake`, `env`, `level`; 2 s batches; `flushLogs()` before exit). Errors go through `errInfo()` (name, message, status, stack only) and a redact list covers auth/token keys.

## Layout

- `src/mail.ts` pure parsing, sender-auth check, MIME building. `src/gmail.ts` Gmail API calls. `src/crm.ts` CRM contract. `src/extract.ts` prompt + answer parsing. `src/ai.ts` providers + model switching. `src/validate.ts` payload checks. `src/queue.ts` queue + sweeps. `src/alert.ts` alert emails. `src/server.ts` HTTP + timers. `src/env.ts` lazy zod env (`getEnv()`), so modules import without side effects.
- `scripts/authorize.ts` loopback OAuth (Desktop client). `scripts/dry-run.ts` one message, no side effects (AI alerts can still be sent).

## Commands

`npm run build` · `npm start` · `npm test` · `npx tsc --noEmit` · `npx eslint .` · `npm run dry-run -- <id>` · `npm run authorize`

## Known issues / open points

- CRM `users` field in the reference endpoint is a pending CRM change; until it ships, names are matched against email local parts.
- Intra-Workspace mail may arrive without a `mx.google.com` Authentication-Results header; if so every mail is `CRM-Ignored`. Confirm on real mail during the dry-run period.
- Nothing has been run against live Gmail, Pub/Sub, OpenRouter or the CRM yet.
