import { readFileSync } from "node:fs";
import { z } from "zod";
import { askJson, type Answer, type ReadResult } from "./ai.js";
import type { LeadPayload, Reference } from "./crm.js";
import { getEnv } from "./env.js";
import type { Mail } from "./mail.js";
import { cleanThread, fitBody, renderHints, type ThreadHints } from "./thread.js";

// Must match one of the CRM's sources (case-insensitive) to fill the lead's Source field, not just its notes.
export const SOURCE = "Email marketing";

// Every field is required and nullable, so strict JSON-schema mode works on every provider.
const LeadDraft = z.strictObject({
  companyName: z.string().describe("The client company that is inquiring, never the agency itself."),
  email: z.string().nullable().describe("Client contact email, exactly as written in the mail, or null."),
  mobile: z.string().nullable().describe("Client mobile number, digits only, without the dial code, or null."),
  mobileCountryCode: z.string().nullable().describe('Dial code written with the number, such as "+44" or "+971"; null if none is written.'),
  contactName: z.string().nullable(),
  designation: z.string().nullable(),
  city: z.string().nullable(),
  budget: z.string().nullable(),
  notes: z.string().nullable().describe("Short summary of useful details that have no other field."),
  services: z.array(z.string()).describe("Names from the services list only; empty when none is clearly named."),
  salesPersonEmails: z.array(z.string()).describe("Emails from the assignees or users list only."),
});

const REVIEW_CODES = ["no_client_contact", "multiple_companies", "not_a_lead"] as const;

const Extraction = z.strictObject({
  decision: z.enum(["create", "review"]),
  reviewCode: z.enum(REVIEW_CODES).nullable().describe("Required when decision is review; null otherwise."),
  reason: z.string().nullable().describe("Required when decision is review: one short line saying what is missing or unclear."),
  lead: LeadDraft.nullable().describe("The lead. Include whatever you could extract, even when decision is review."),
});

export type Extraction = z.infer<typeof Extraction>;

export type ExtractResult =
  | { ok: true; payload: LeadPayload }
  | { ok: false; reason: string; draft?: LeadPayload };

const PROMPT_FILE = new URL("../prompts/system.md", import.meta.url);
let promptTemplate: string | undefined;

// The system prompt lives in prompts/system.md so it can be edited without touching code; read once per process.
export function systemPrompt(company: string): string {
  promptTemplate ??= readFileSync(PROMPT_FILE, "utf8");
  return promptTemplate.replaceAll("{{COMPANY_NAME}}", company);
}

// Salespeople to assign: To: recipients who are CRM users, minus our own addresses (sender, intake mailbox, lead generator).
export function recipientAssignees(mail: Mail, reference: Reference, exclude: string[]): string[] {
  const users = new Set(reference.users.map((u) => u.email.toLowerCase()));
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  return mail.to.filter((a) => users.has(a) && !skip.has(a));
}

// To: addresses on one of our own domains that the reference doesn't know: a sign the cached user list is stale.
export function unknownColleagues(mail: Mail, reference: Reference, internalEmails: string[], exclude: string[]): string[] {
  const domain = (a: string) => a.split("@")[1] ?? "";
  const users = new Set(reference.users.map((u) => u.email.toLowerCase()));
  const domains = new Set([...reference.users.map((u) => u.email), ...internalEmails].map((e) => domain(e.toLowerCase())));
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  return mail.to.filter((a) => domains.has(domain(a)) && !users.has(a) && !skip.has(a));
}

// The users list is left out when assignees already come from To:, which keeps the prompt small for free models.
// Parts that are the same for every mail come first, so providers with prompt caching can reuse that prefix.
export function buildUserMessage(mail: Mail, reference: Reference, assignees: string[] = [], hints?: ThreadHints): string {
  const users = reference.users.map((u) => `${u.name} <${u.email}>`).join("\n");
  const services = reference.services.map((s) => `- ${s}`).join("\n") || "(none)";
  return [
    `<services>\n${services}\n</services>`,
    assignees.length ? `<assignees>\n${assignees.join("\n")}\n</assignees>` : `<users>\n${users}\n</users>`,
    ...(hints ? [renderHints(hints)] : []),
    "<mail>",
    `From: ${mail.fromHeader}`,
    `To: ${mail.to.join(", ")}`,
    `Cc: ${mail.cc.join(", ")}`,
    `Date: ${mail.date}`,
    `Subject: ${mail.subject}`,
    "",
    fitBody(cleanThread(mail.body)),
    "</mail>",
  ].join("\n");
}

function clean(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

// Maps the model's draft to the CRM payload, dropping empty values and fixing the source.
export function toPayload(draft: z.infer<typeof LeadDraft>): LeadPayload {
  const payload: LeadPayload = {
    companyName: draft.companyName.trim(),
    source: SOURCE,
    salesPersonEmails: draft.salesPersonEmails.map((e) => e.trim().toLowerCase()).filter(Boolean),
  };
  const strings = ["email", "mobile", "contactName", "designation", "city", "budget", "notes"] as const;
  for (const key of strings) {
    const v = clean(draft[key]);
    if (v) payload[key] = v;
  }
  if (payload.email) payload.email = payload.email.toLowerCase();
  if (payload.mobile) payload.mobileCountryCode = clean(draft.mobileCountryCode) ?? "+91";
  const services = (draft.services ?? []).map((s) => s.trim()).filter(Boolean);
  if (services.length) payload.services = services;
  return payload;
}

// The AI may only send a mail to review for a real blocker; anything else is created and left to the code checks.
export function interpret(extraction: Extraction): ExtractResult {
  const draft = extraction.lead ? toPayload(extraction.lead) : undefined;
  const reason = clean(extraction.reason) ?? "AI could not extract a complete lead";
  if (!draft) return { ok: false, reason };
  if (extraction.decision !== "review") return { ok: true, payload: draft };
  const blocked =
    extraction.reviewCode === "multiple_companies" || extraction.reviewCode === "not_a_lead" || (!draft.email && !draft.mobile);
  return blocked ? { ok: false, reason, draft } : { ok: true, payload: draft };
}

// Minimal lead from code-found facts, used when no AI model returned a usable answer.
export function fallbackLead(hints: ThreadHints, assignees: string[], why: string): LeadPayload | undefined {
  const contact = hints.outsideParticipants[0];
  if (!contact || !hints.companyGuess || !assignees.length) return undefined;
  return {
    companyName: hints.companyGuess,
    email: contact.email,
    ...(contact.name ? { contactName: contact.name } : {}),
    source: SOURCE,
    salesPersonEmails: assignees,
    notes: `Created without AI (${why}); please check the company name and complete the details.`,
  };
}

const RESPONSE_SCHEMA: Record<string, unknown> = { ...z.toJSONSchema(Extraction) };
delete RESPONSE_SCHEMA.$schema;

// Pulls the JSON object out of a reply, ignoring <think> blocks, code fences or text around it.
export function parseJsonContent(content: string): unknown {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new SyntaxError("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

// Turns one model answer into a result, or a reason it was unusable.
export function readAnswer({ content, finishReason }: Answer): ReadResult<ExtractResult> {
  if (finishReason === "length") return { ok: false, unusable: "AI response was cut off" };
  if (finishReason === "content_filter") return { ok: false, unusable: "AI declined to process this mail" };
  if (!content) return { ok: false, unusable: "AI returned no usable lead" };
  let json: unknown;
  try {
    json = parseJsonContent(content);
  } catch {
    return { ok: false, unusable: "AI returned output that was not JSON" };
  }
  const parsed = Extraction.safeParse(json);
  if (!parsed.success) return { ok: false, unusable: "AI returned output that did not match the lead format" };
  return { ok: true, value: interpret(parsed.data) };
}

// Throws AiUnavailableError when every model errored. Unusable answers from all models fall back to a hint-built lead.
// assignees: salespeople already chosen from To:, which override whatever the AI picked.
export async function extract(mail: Mail, reference: Reference, assignees: string[] = [], hints?: ThreadHints): Promise<ExtractResult> {
  const system = systemPrompt(getEnv().COMPANY_NAME);
  const result = await askJson(system, buildUserMessage(mail, reference, assignees, hints), RESPONSE_SCHEMA, readAnswer, {
    messageId: mail.id,
    mailSubject: mail.subject,
  });
  if (!result.ok) {
    const fallback = hints && fallbackLead(hints, assignees, result.unusable);
    return fallback ? { ok: true, payload: fallback } : { ok: false, reason: result.unusable };
  }
  const value = result.value;
  if (!assignees.length) return value;
  if (value.ok) return { ok: true, payload: { ...value.payload, salesPersonEmails: assignees } };
  return value.draft ? { ...value, draft: { ...value.draft, salesPersonEmails: assignees } } : value;
}
