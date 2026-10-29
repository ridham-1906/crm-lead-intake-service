# Logging, Tracing & User-Facing Errors

How to use the observability and error-message layers. Architectural reasoning
lives in `.project/context.md`; this file is the practical guide.

---

## The two systems

1. **Observability** — every request, Mongo query and outbound call emits
   structured JSON, correlated by one `requestId`, shipped to Grafana Loki.
2. **User-facing errors** — one vocabulary of sentences a user may read. Nothing
   authored by Mongo, Clerk or Zod reaches a toast.

They meet at the request ID. When a user hits something they cannot act on, the
toast reads `Something went wrong. Please try again. (ref a1b2c3d4)` — the first
8 characters of the `requestId`. Paste it into Grafana for the full stack.

---

## Files

| File | Owns |
| --- | --- |
| `src/lib/logger.ts` | Root Pino instance, transport selection, redaction list |
| `src/lib/requestContext.ts` | Request scope — `getLog`, `setUser`, `setBody`, `withTrace` |
| `src/middleware/requestLogger.ts` | `withRequestLog()` — the access log |
| `src/lib/userMessage.ts` | Every user-visible failure sentence |
| `src/instrumentation.ts` | Boot hook, runs in **all** runtimes — only dispatches |
| `src/instrumentation-node.ts` | Node-only: Mongoose plugin, crash handlers, shutdown flush |

The instrumentation split is not stylistic. `instrumentation.ts` is evaluated on
Edge too, and the bundler analyses imports statically — a `NEXT_RUNTIME` check
alone still pulls `process.on` into the Edge bundle and costs 5 build warnings.
The dynamic `import()` is the documented Next pattern.

---

## Developer recipes

### Writing a route

`handle()` takes the request. That is the whole contract:

```ts
export function GET(req: NextRequest) {
  return handle(req, async () => {
    const user = await requirePermission("clients", "view");
    return ok(items);
  });
}
```

You get logging, request-ID correlation, the DB connection and error mapping for
free. `req` is required — it is how the log line learns the method and path.

### Logging inside a request

```ts
import { getLog } from "@/lib/requestContext";

getLog().info({ subDealId }, "sub-deal close accepted");
```

`getLog()` returns a child logger already bound to `requestId`, `method`, `path`,
`userId` and `role`.

> **Never import `logger` directly in request code** — you lose the correlation.
> `logger` is for boot and shutdown only, outside any request.

### Tracing an outbound call

```ts
import { withTrace } from "@/lib/requestContext";

await withTrace("stripe", "createCharge", () => stripe.charges.create(…));
```

Logs duration and outcome under the current request, and rethrows on failure. All
five Clerk wrappers in `src/lib/clerk.ts` already use it.

Do **not** use it where a throw is caught and converted to a fallback —
`src/lib/emailDomain.ts` fails open by design, so it logs explicitly instead
(`debug` for a domain that genuinely has no mail server, `warn` when a resolver
error causes the fail-open).

### Adding a user-facing message

All user text goes through `src/lib/userMessage.ts`. Do not write it in a route.

| Need | Do this |
| --- | --- |
| A field needs a human name | Add to `FIELD_LABELS` — `gstNumber: "GST number"`. Duplicate and validation messages pick it up automatically |
| A new Clerk error code | Add to `CLERK_MESSAGES` |
| A validation message shown verbatim | `ctx.addIssue({ code: "custom", path: ["mobile"], message })` in a `superRefine` |

`code: "custom"` can only come from our own `addIssue`, so those messages are
shown as written. Zod's built-in codes get `"Please check the mobile number."`
instead, because their defaults read like
`Too small: expected string to have >=1 characters`.

### Surfacing an error in the UI

```ts
useMutation({ mutationFn: …, onError: toastApiError })
```

Never hand-roll `err instanceof ApiError ? err.message : "…"`. `toastApiError`
also handles the case where the request never got a reply, reporting it as
offline rather than borrowing the 500 wording.

---

## Operations

### Environment

```bash
LOG_LEVEL=            # leave empty — defaults to info in prod, debug in dev
LOKI_URL=             # bare origin ONLY: https://logs-prod-006.grafana.net
LOKI_USERNAME=        # numeric user ID
LOKI_PASSWORD=        # glc_… access policy token, scope logs:write
```

Get all three from **grafana.com → your stack → Loki → Send Logs**. The password
is generated once and not shown again.

> `LOKI_URL` must **not** include `/loki/api/v1/push` — pino-loki appends it.
> Include it and requests POST to a doubled path and 404 with no obvious cause.
> Strip any embedded `user:token@` too; credentials are passed separately.

With `LOKI_URL` unset, everything degrades to stdout. The app never fails to boot
over a missing or misconfigured log sink.

The Loki target is gated on `LOKI_URL` alone, **not** on `NODE_ENV` — so a dev
machine with the vars set ships to Loki as well, labelled `env="development"`.
That is deliberate: gating on production made the pipeline impossible to verify
before deploying.

### Log levels

| Level | Emits | Volume |
| --- | --- | --- |
| `info` | request completions, boot, shutdown | ~1–2 lines/request |
| `warn` | 4xx, proxy 401s, queries over 500ms, DNS fail-open | — |
| `error` | 5xx, exceptions with stack **and** request body, failed outbound | — |
| `debug` | **every Mongo query**, every successful outbound call | 10–30× more |

Run at `info`. Set `LOG_LEVEL=debug` in Railway only while investigating — it is
read once at process start, so it needs a restart, which a variable change
triggers automatically.

### Message reference

Query by `msg` to isolate a category.

| `msg` | Level | When |
| --- | --- | --- |
| `request completed` | info | 2xx/3xx |
| `request rejected` | warning | 4xx |
| `request failed` | error | 5xx returned |
| `request threw` | error | exception — carries `err.stack` **and** request body |
| `request error` | error | RSC render / Server Action / proxy |
| `unauthenticated api request` | warning | proxy-issued 401 |
| `slow mongo query` | warning | query over 500ms |
| `mongo query` | debug | every query |
| `outbound ok` / `outbound failed` | debug / error | Clerk, DNS |
| `dns check failed open` | warning | email domain check degraded |
| `unhandled rejection` | error | stray promise rejection |
| `uncaught exception` | **critical** | crash — process then exits 1 |

---

## Grafana queries

```logql
{app="ep-crm", level="error"}                        # everything broken
{app="ep-crm"} | json | res_status >= 500            # just 500s
{app="ep-crm"} | json | path =~ "/api/deals.*"       # one route family
{app="ep-crm"} | json | res_status >= 500 | path != "/api/users/me"
```

**The one that answers "why did it fail"** — take a `requestId` from any hit and
expand it into the whole request: every Mongo query with its duration, every
Clerk call, and the exception with its stack.

```logql
{app="ep-crm"} | json | requestId = "0f2c8a91-…"
```

From a user-reported `ref` code (only the first 8 characters):

```logql
{app="ep-crm"} | json | requestId =~ "a1b2c3d4.*"
```

Readable one-line output instead of raw JSON:

```logql
{app="ep-crm", level="error"} | json
  | line_format "{{.method}} {{.path}} → {{.res_status}} ({{.res_durationMs}}ms) {{.err_message}}"
```

Dashboard-worthy:

```logql
sum by (path) (count_over_time({app="ep-crm"} | json | res_status >= 500 [1h]))
quantile_over_time(0.95, {app="ep-crm"} | json | unwrap res_durationMs [5m]) by (path)
```

### Query gotchas

- **Filter on the `level` label, not the parsed field.** `level` exists twice —
  the Loki label holds the word (`error`), Pino's JSON holds the number (`50`).
  After `| json` the numeric one is renamed `level_extracted`, so
  `| json | level = "error"` silently matches nothing.
- **Pino's `warn` is Loki's `warning`; `fatal` is `critical`.**
- **Testing locally, query `env="development"`** — the label comes from
  `NODE_ENV`, so `env="production"` returns nothing from a dev machine.

---

## Conventions that break things if ignored

- **Loki labels stay `app` / `env` / `level`.** A `requestId` label would create
  one Loki stream per request and break the ingester. High-cardinality values
  belong in the JSON line, queried with `| json`.
- **`toErrorResponse` must not log.** `withRequestLog` already logs every throw
  with its stack and body; a second call doubles every 500 in the Loki bill.
- **`registerQueryLogging()` must run before any model compiles.** A global
  Mongoose plugin only applies to schemas registered after it — hence its place
  in `registerNode()` rather than a lazy call.
- **`SessionGuard` branches on `error.status`, never message text.** Keep it that
  way so messages stay free to reword.
- **Node-only code goes in `instrumentation-node.ts`,** never `instrumentation.ts`.
- **Wrap every `details` argument in `devDetails()`.** It strips them in
  production; raw `details` ships Mongo `keyValue` and Clerk error arrays to the
  browser, and nothing in the UI reads them anyway.

---

## Verifying the pipeline

A standalone probe that tests the Loki credentials with no Next involved. Run
from the project root so `pino` resolves:

```bash
node --env-file=.env --input-type=module -e '
import pino from "pino";
const logger = pino({ base: { service: "ep-crm", env: "smoketest" } },
  pino.transport({ target: "pino-loki", options: {
    host: process.env.LOKI_URL,
    basicAuth: { username: process.env.LOKI_USERNAME, password: process.env.LOKI_PASSWORD },
    batching: false, silenceErrors: false,
    labels: { app: "ep-crm", env: "smoketest" },
  }}));
logger.error({ probe: true }, "loki smoketest line");
setTimeout(() => logger.flush(() => process.exit(0)), 1500);
'
```

`silenceErrors: false` makes a bad URL or token fail loudly. Then confirm in
Grafana:

```logql
{app="ep-crm", env="smoketest"}
```

If the line is there, the credentials and URL are correct and any remaining
problem is in application wiring, not the sink.

### Shutdown behaviour — known limit

`instrumentation-node.ts` waits for `logger.flush()`'s callback before exiting,
with a 2.5s backstop. But `flush()` only drains Pino's own buffer into the
transport worker — it cannot force pino-loki to POST a batch still waiting on its
interval timer. The batch interval is therefore 2s, below the shutdown grace, to
cap what is in flight.

A hard-killed process can still lose that last batch. **stdout is the durable
record**, which is why it is always a target regardless of Loki.
