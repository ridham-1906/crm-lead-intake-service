import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { OAuth2Client } from "google-auth-library";
import { getEnv } from "./env.js";
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

async function renewWatch(trigger: string): Promise<void> {
  try {
    const expiration = await watch();
    log.info({ trigger, expiration }, "gmail watch renewed");
  } catch (err) {
    log.error({ err: errInfo(err), trigger }, "gmail watch failed");
    await alert({ stage: "Watch", summary: "renewing the Gmail watch failed; new mail only arrives via sweeps", error: err });
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  await assertMailbox();
  await ensureLabels();

  createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error({ err: errInfo(err) }, "request failed");
      if (!res.headersSent) send(res, 500, { error: "Internal error" });
    });
  }).listen(env.PORT, () => log.info({ port: env.PORT, mailbox: env.INTAKE_MAILBOX, dryRun: env.DRY_RUN }, "ep-lead-intake listening"));

  await renewWatch("boot");
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
    log.info({ signal, queue: queueStatus() }, "shutting down");
    void exit(0);
  });
}

main().catch(async (err: unknown) => {
  log.fatal({ err: errInfo(err) }, "boot failed");
  // An invalid environment means alerts cannot be configured either.
  if (!(err instanceof Error && err.message.startsWith("Invalid environment"))) {
    await alert({ stage: "Boot", summary: "service failed to start", error: err });
  }
  await exit(1);
});
