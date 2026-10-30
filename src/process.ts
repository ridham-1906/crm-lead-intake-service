import { createLead, getReference, invalidateReference, type LeadPayload, type Reference } from "./crm.js";
import { getEnv } from "./env.js";
import { buildUserMessage, extract, recipientAssignees, unknownColleagues } from "./extract.js";
import * as gmail from "./gmail.js";
import { dumpToFile, log } from "./log.js";
import { isSenderAuthenticated, searchableText, type Mail } from "./mail.js";
import { validate } from "./validate.js";

export type Draft = { ok: true; payload: LeadPayload } | { ok: false; reason: string; draft?: LeadPayload };

export type Outcome = "done" | "review" | "ignored" | "skipped";

const STALE_REASON = /^Unknown (salesperson|service)/;

// Re-fetches the CRM lists unless this copy was fetched just now.
async function refreshed(reference: Reference, mailId: string, why: string): Promise<Reference> {
  if (Date.now() - (reference.fetchedAt ?? 0) < 2000) return reference;
  log.info({ messageId: mailId, why }, "crm reference refreshed");
  return getReference(0);
}

// AI extraction followed by code validation; shared with scripts/dry-run.ts.
// A cached reference that misses a new CRM user or service is refreshed once before giving up.
export async function draftLead(mail: Mail, cached: Reference): Promise<Draft> {
  const env = getEnv();
  const exclude = [mail.from, env.INTAKE_MAILBOX, env.LEAD_GENERATOR_EMAIL];
  const internal = [env.INTAKE_MAILBOX, env.LEAD_GENERATOR_EMAIL, ...env.ALLOWED_SENDERS];

  let reference = cached;
  const unknown = unknownColleagues(mail, reference, internal, exclude);
  if (unknown.length) reference = await refreshed(reference, mail.id, `To: has unknown colleagues ${unknown.join(", ")}`);

  const assignees = recipientAssignees(mail, reference, exclude);
  if (env.DEBUG_DUMP) await dumpToFile(mail.id, "AI input (exactly what the model receives)", buildUserMessage(mail, reference, assignees));
  const extracted = await extract(mail, reference, assignees);
  if (env.DEBUG_DUMP) await dumpToFile(mail.id, "AI result", JSON.stringify(extracted, null, 2));
  if (!extracted.ok) return extracted;

  let checked = validate(extracted.payload, reference, searchableText(mail), internal);
  if (!checked.ok && STALE_REASON.test(checked.reason)) {
    const fresh = await refreshed(reference, mail.id, checked.reason);
    if (fresh !== reference) checked = validate(extracted.payload, fresh, searchableText(mail), internal);
  }
  if (env.DEBUG_DUMP) await dumpToFile(mail.id, "Validation", JSON.stringify(checked, null, 2));
  return checked.ok ? checked : { ok: false, reason: checked.reason, draft: extracted.payload };
}

// DEBUG_DUMP: the parsed mail as the service sees it, written to a temp file whose path goes to the console.
async function dumpMail(mail: Mail): Promise<void> {
  const text = [
    `Gmail id:   ${mail.id}  (thread ${mail.threadId})`,
    `Labels:     ${mail.labelIds.join(", ")}`,
    `From:       ${mail.fromHeader}`,
    `To:         ${mail.to.join(", ")}`,
    `Cc:         ${mail.cc.join(", ")}`,
    `Subject:    ${mail.subject}`,
    `Date:       ${mail.date}`,
    `Auth:       ${mail.authResults.join("\n            ") || "(no Authentication-Results header)"}`,
    `Body chars: ${mail.body.length}`,
    "",
    mail.body,
  ].join("\n");
  const file = await dumpToFile(mail.id, "Mail received", text);
  console.log(`[debug] mail ${mail.id} "${mail.subject}" from ${mail.from} → ${file}`);
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
  await gmail.addLabel(mail.id, gmail.REVIEW);
}

// Runs one message through the pipeline; the outcome label is applied last so a crash means a retry.
export async function processMessage(id: string): Promise<Outcome> {
  const env = getEnv();
  const mail = await gmail.getMail(id);
  const ctx = { messageId: id, dryRun: env.DRY_RUN };
  if (gmail.hasOutcomeLabel(mail)) return "skipped";
  if (env.DEBUG_DUMP) await dumpMail(mail);

  const rejected = senderCheck(mail);
  if (env.DEBUG_DUMP) await dumpToFile(id, "Sender check", rejected ?? "passed (allowed sender, authenticated)");
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
    // The CRM knows better than our cache: make the next mail fetch fresh lists.
    if (/salesperson|service|access to leads/i.test(result.error)) invalidateReference();
    log.info({ ...ctx, outcome: "review", reason: result.error, status: result.status }, "CRM refused lead");
    await review(mail, result.error, draft.payload);
    return "review";
  }

  // No mail on success: the CRM itself notifies the assigned salespeople.
  await gmail.addLabel(id, gmail.DONE);
  log.info({ ...ctx, outcome: "done", leadId: result.leadId, client: result.client, salesPersons: result.salesPersons }, "lead created");
  return "done";
}
