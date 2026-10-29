import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { OAuth2Client } from "google-auth-library";
import { getReference } from "./crm.js";
import { EnvError, getEnv } from "./env.js";
import { alert } from "./alert.js";
import { assertMailbox, ensureLabels, watch } from "./gmail.js";
import { errInfo, flushLogs, log } from "./log.js";
import { queueStatus, sweep } from "./queue.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const oidc = new OAuth2Client();

// Accepts only Google-signed OIDC tokens for our audience, issued to the push subscription's service account.
async function isPubSubRequest(req: IncomingMessage): Promise<boolean> {
  const env = getEnv();
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return false;
  try {
    const ticket = await oidc.verifyIdToken({ idToken: token, audience: env.PUBSUB_AUDIENCE });
    const payload = ticket.getPayload();
    return payload?.email === env.PUBSUB_SERVICE_ACCOUNT && payload.email_verified === true;
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body?: object): void {
  res.writeHead(status, body ? { "Content-Type": "application/json" } : {});
  res.end(body ? JSON.stringify(body) : undefined);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, queue: queueStatus() });

  if (req.method === "POST" && path === "/gmail/push") {
    req.resume();
    if (!(await isPubSubRequest(req))) return send(res, 401, { error: "Unauthorized" });
    // Ack first; the push carries no data we need, it only triggers a search.
    send(res, 204);
    void sweep("push");
    return;
  }

  send(res, 404, { error: "Not found" });
}

// A startup step that failed, with the reason and what to do about it.
class StartupError extends Error {
  constructor(
    readonly step: string,
    readonly cause: unknown,
  ) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

// Turns common Google, CRM and network errors into a one-line fix.
function hintFor(err: unknown): string | undefined {
  const e = err as { message?: string; code?: unknown; status?: unknown };
  const msg = e.message ?? "";
  if (msg.includes("invalid_grant")) {
    return "GMAIL_REFRESH_TOKEN was not issued to this GOOGLE_CLIENT_ID or was revoked; run `npm run authorize` signed in as INTAKE_MAILBOX";
  }
  if (msg.includes("invalid_client") || msg.includes("unauthorized_client")) {
    return "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are wrong or the OAuth client was deleted";
  }
  if (msg.includes("but INTAKE_MAILBOX is")) return "run `npm run authorize` signed in as INTAKE_MAILBOX, or fix INTAKE_MAILBOX";
  if (e.code === "EADDRINUSE") return "PORT is already in use; stop the other process or change PORT";
  if (/topic|pubsub|User not authorized to perform this action/i.test(msg)) {
    return "check GMAIL_PUBSUB_TOPIC exists and gmail-api-push@system.gserviceaccount.com has Pub/Sub Publisher on it";
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|ETIMEDOUT/i.test(msg)) return "network or host unreachable; check the URL and connectivity";
  if (/ 401/.test(msg)) return "the API key was rejected";
  if (/ 404/.test(msg)) return "endpoint not found; check the base URL";
  return undefined;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    console.log(`startup: ${name} ok`);
    return result;
  } catch (err) {
    throw new StartupError(name, err);
  }
}

// Non-fatal startup check: logs a warning with a hint instead of stopping the service.
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    console.log(`startup: ${name} ok (${await fn()})`);
  } catch (err) {
    log.warn({ step: name, err: errInfo(err), hint: hintFor(err) }, `startup: ${name} failed; continuing`);
  }
}

function listen(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        log.error({ err: errInfo(err) }, "request failed");
        if (!res.headersSent) send(res, 500, { error: "Internal error" });
      });
    });
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
}

async function renewWatch(trigger: string): Promise<void> {
  try {
    const expiration = await watch();
    console.log(`gmail watch renewed (${trigger})${expiration ? `, expires ${new Date(Number(expiration)).toISOString()}` : ""}`);
  } catch (err) {
    log.error({ err: errInfo(err), trigger, hint: hintFor(err) }, "gmail watch failed; new mail only arrives via sweeps");
    await alert({ stage: "Watch", summary: "renewing the Gmail watch failed; new mail only arrives via sweeps", error: err });
  }
}

async function main(): Promise<void> {
  console.log(`ep-lead-intake starting (node ${process.version})`);
  const env = await step("environment", async () => getEnv());
  await step("gmail sign-in as INTAKE_MAILBOX", assertMailbox);
  await step("gmail labels", ensureLabels);
  await step(`http server on port ${env.PORT}`, () => listen(env.PORT));

  await check("crm reference", async () => {
    const ref = await getReference();
    return `${ref.users.length} users, ${ref.services.length} services`;
  });
  await renewWatch("boot");

  console.log(`ep-lead-intake started on port ${env.PORT}${env.DRY_RUN ? " (DRY RUN: no leads created, no mail sent)" : ""}`);

  await sweep("boot");
  setInterval(() => void renewWatch("daily"), DAY_MS);
  // Picks up mail whose push was missed and retries mail that failed transiently.
  setInterval(() => void sweep("interval"), env.SWEEP_INTERVAL_MINUTES * 60_000);
}

async function exit(code: number): Promise<never> {
  await flushLogs();
  process.exit(code);
}

process.on("unhandledRejection", (err) => {
  log.error({ err: errInfo(err) }, "unhandled rejection");
  void alert({ stage: "Crash", summary: "unhandled promise rejection", error: err });
});

process.on("uncaughtException", (err) => {
  log.fatal({ err: errInfo(err) }, "uncaught exception");
  // The process is in an unknown state: give the alert a few seconds, then exit.
  void Promise.race([alert({ stage: "Crash", summary: "uncaught exception; service restarting", error: err }), sleep(5000)]).then(
    () => exit(1),
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`shutting down (${signal}), ${queueStatus().pending} mail(s) still queued`);
    void exit(0);
  });
}

main().catch(async (err: unknown) => {
  const step = err instanceof StartupError ? err.step : "startup";
  const cause = err instanceof StartupError ? err.cause : err;

  if (cause instanceof EnvError) {
    // Without a valid environment there is no alert address either: the log is the only report.
    log.fatal({ step, missing: cause.missing, invalid: cause.invalid }, `startup failed: ${cause.message}`);
    return exit(1);
  }

  const hint = hintFor(cause);
  log.fatal({ step, err: errInfo(cause), hint }, `startup failed at "${step}": ${errInfo(cause).message}${hint ? ` (fix: ${hint})` : ""}`);
  await alert({ stage: "Boot", summary: `service failed to start at "${step}"`, error: cause, ...(hint ? { extra: { fix: hint } } : {}) });
  await exit(1);
});
