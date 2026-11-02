import { getEnv } from "./env.js";
import { sendMail } from "./gmail.js";
import { errInfo, log } from "./log.js";

export type Stage = "AI" | "CRM" | "Gmail" | "Boot" | "Watch" | "Processing" | "Crash";

export type AlertDetails = {
  stage: Stage;
  summary: string;
  error?: unknown;
  messageId?: string;
  mailSubject?: string;
  extra?: Record<string, unknown>;
};

const lastSent = new Map<string, { at: number; suppressed: number }>();
let muted = false;

// For local scripts (dry-run, try-examples): alerts are printed instead of emailed.
export function muteAlerts(): void {
  muted = true;
}

// Emails ALERT_EMAIL about a failure; the same stage + error is sent at most once per ALERT_THROTTLE_MINUTES.
export async function alert(details: AlertDetails): Promise<void> {
  if (muted) {
    console.log(`[alert muted] ${details.stage}: ${details.summary}${details.error ? ` (${errInfo(details.error).message})` : ""}`);
    return;
  }
  const env = getEnv();
  const err = details.error === undefined ? undefined : errInfo(details.error);
  const key = `${details.stage}|${details.summary}|${err?.message ?? ""}`.slice(0, 500);
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev && now - prev.at < env.ALERT_THROTTLE_MINUTES * 60_000) {
    prev.suppressed++;
    return;
  }
  lastSent.set(key, { at: now, suppressed: 0 });

  const text = [
    `ep-lead-intake hit an error on ${env.INTAKE_MAILBOX}.`,
    "",
    `What failed: ${details.stage}`,
    `Summary:     ${details.summary}`,
    ...(err ? [`Error:       ${err.name}: ${err.message}`] : []),
    ...(err?.status !== undefined ? [`Status:      ${String(err.status)}`] : []),
    ...(details.messageId ? [`Gmail id:    ${details.messageId}`] : []),
    ...(details.mailSubject ? [`Mail:        ${details.mailSubject}`] : []),
    ...Object.entries(details.extra ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`),
    ...(prev?.suppressed ? [`(${prev.suppressed} more of the same since the last alert)`] : []),
    `Time:        ${new Date(now).toISOString()}`,
    `Dry run:     ${env.DRY_RUN}`,
    "",
    details.messageId
      ? "The mail is left unlabelled and will be retried automatically on the next sweep."
      : "Check the service logs for details.",
  ].join("\n");

  try {
    await Promise.all(env.ALERT_EMAIL.map((to) => sendMail(to, `[ep-lead-intake] ${details.stage} failure: ${details.summary}`, text)));
    log.info({ stage: details.stage, summary: details.summary }, "alert sent");
  } catch (sendErr) {
    // Gmail itself may be what is failing; the log is all that is left.
    log.error({ err: errInfo(sendErr), stage: details.stage, summary: details.summary }, "alert email failed");
  }
}
