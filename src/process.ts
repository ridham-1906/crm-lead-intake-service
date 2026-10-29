import { createLead, getReference, type LeadPayload, type Reference } from "./crm.js";
import { getEnv } from "./env.js";
import { extract, recipientAssignees } from "./extract.js";
import * as gmail from "./gmail.js";
import { log } from "./log.js";
import { isSenderAuthenticated, searchableText, type Mail } from "./mail.js";
import { validate } from "./validate.js";

export type Draft = { ok: true; payload: LeadPayload } | { ok: false; reason: string; draft?: LeadPayload };

export type Outcome = "done" | "review" | "ignored" | "skipped";

// AI extraction followed by code validation; shared with scripts/dry-run.ts.
export async function draftLead(mail: Mail, reference: Reference): Promise<Draft> {
  const env = getEnv();
  const assignees = recipientAssignees(mail, reference, [mail.from, env.INTAKE_MAILBOX, env.LEAD_GENERATOR_EMAIL]);
  const extracted = await extract(mail, reference, assignees);
  if (!extracted.ok) return extracted;
  const internal = [env.INTAKE_MAILBOX, ...env.ALLOWED_SENDERS];
  const checked = validate(extracted.payload, reference, searchableText(mail), internal);
  return checked.ok ? checked : { ok: false, reason: checked.reason, draft: extracted.payload };
}

export function senderCheck(mail: Mail): string | undefined {
  if (!getEnv().ALLOWED_SENDERS.includes(mail.from)) return "sender not on the allowlist";
  if (!isSenderAuthenticated(mail)) return "sender failed DMARC/SPF+DKIM";
  return undefined;
}

async function review(mail: Mail, reason: string, draft?: LeadPayload): Promise<void> {
  const env = getEnv();
  const note = [
    "Couldn't create this lead automatically.",
    `Reason: ${reason}`,
    ...(draft ? ["", "Draft payload (check before reusing):", JSON.stringify(draft, null, 2)] : []),
  ].join("\n");
  await gmail.forward(mail, env.LEAD_GENERATOR_EMAIL, note);
  await gmail.reply(
    mail,
    `Couldn't create this lead automatically (${reason}). Forwarded to ${env.LEAD_GENERATOR_EMAIL} to add by hand.`,
  );
  await gmail.addLabel(mail.id, gmail.REVIEW);
}

// Runs one message through the pipeline; the outcome label is applied last so a crash means a retry.
export async function processMessage(id: string): Promise<Outcome> {
  const env = getEnv();
  const mail = await gmail.getMail(id);
  const ctx = { messageId: id, dryRun: env.DRY_RUN };
  if (gmail.hasOutcomeLabel(mail)) return "skipped";

  const rejected = senderCheck(mail);
  if (rejected) {
    log.info({ ...ctx, outcome: "ignored", reason: rejected }, "mail ignored");
    if (!env.DRY_RUN) await gmail.addLabel(id, gmail.IGNORED);
    return "ignored";
  }

  const reference = await getReference();
  const draft = await draftLead(mail, reference);

  if (!draft.ok) {
    log.info({ ...ctx, outcome: "review", reason: draft.reason, draft: draft.draft }, "mail sent to review");
    if (!env.DRY_RUN) await review(mail, draft.reason, draft.draft);
    return "review";
  }

  if (env.DRY_RUN) {
    log.info({ ...ctx, outcome: "done", payload: draft.payload }, "dry run: lead not created");
    return "done";
  }

  const result = await createLead(draft.payload);
  if (result.kind === "rejected") {
    log.info({ ...ctx, outcome: "review", reason: result.error, status: result.status }, "CRM refused lead");
    await review(mail, result.error, draft.payload);
    return "review";
  }

  const names = result.salesPersons.length ? result.salesPersons.join(", ") : draft.payload.salesPersonEmails.join(", ");
  await gmail.reply(mail, `Lead #${result.leadId} created for ${draft.payload.companyName}, assigned to ${names}.`);
  await gmail.addLabel(id, gmail.DONE);
  log.info({ ...ctx, outcome: "done", leadId: result.leadId, client: result.client }, "lead created");
  return "done";
}
