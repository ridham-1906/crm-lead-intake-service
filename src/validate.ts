import { z } from "zod";
import type { LeadPayload, Reference } from "./crm.js";

export type ValidateResult = { ok: true; payload: LeadPayload } | { ok: false; reason: string };

// The CRM refuses unknown keys, so the payload shape is checked strictly.
const PayloadShape = z.strictObject({
  companyName: z.string(),
  email: z.string().optional(),
  mobile: z.string().optional(),
  mobileCountryCode: z.string().optional(),
  contactName: z.string().optional(),
  designation: z.string().optional(),
  city: z.string().optional(),
  budget: z.string().optional(),
  notes: z.string().optional(),
  source: z.string(),
  services: z.array(z.string()).optional(),
  salesPersonEmails: z.array(z.string()),
});

const digits = (s: string) => s.replace(/\D/g, "");

// Regex for these digits as written in a mail, allowing spaces, dots, dashes and brackets between them.
const spaced = (d: string) => d.split("").join("[\\s().-]*");

// Strips a dial code the AI left in, and a trunk 0: "+65 9123 4567" → 91234567, "098765 43210" → 9876543210.
export function normalizeMobile(mobile: string, countryCode: string, mailText = ""): string {
  let d = digits(mobile);
  const cc = digits(countryCode);
  const writtenWithCode = new RegExp(`\\+[\\s(]*${spaced(d)}`).test(mailText);
  if (cc && d.startsWith(cc) && (writtenWithCode || (cc === "91" && d.length === 12))) d = d.slice(cc.length);
  if (d.startsWith("0") && d.length > 7) d = d.slice(1);
  return d;
}

// The "+code" written right before the number in the mail, e.g. "+971" for "+971 50 123 4567".
export function dialCodeInMail(mailText: string, national: string): string | undefined {
  const match = mailText.match(new RegExp(`\\+[\\s(]*(\\d{1,4})[\\s().-]*(?:0[\\s().-]*)?${spaced(national)}(?!\\d)`));
  return match?.[1] ? `+${match[1]}` : undefined;
}

// Any country: dial code from the mail when written there, else the AI's (default +91). India gets its stricter rule.
function checkMobile(raw: string, aiCode: string | undefined, mailText: string): { mobile: string; code: string } | string {
  const guess = aiCode?.trim() || "+91";
  const mobile = normalizeMobile(raw, guess, mailText);
  if (mobile.length < 6 || !digits(mailText).includes(mobile)) return `Mobile ${raw} does not appear in the mail`;

  const code = dialCodeInMail(mailText, mobile) ?? guess;
  if (!/^\+\d{1,4}$/.test(code)) return `Mobile dial code ${code} is not valid`;
  if (code === "+91") {
    if (!/^[6-9]\d{9}$/.test(mobile)) return `Mobile ${raw} is not a valid Indian mobile number`;
  } else if (mobile.length > 14 || digits(code).length + mobile.length > 15) {
    return `Mobile ${raw} (${code}) is too long to be a valid number`;
  }
  return { mobile, code };
}

// Checks the AI's payload against the mail text and the CRM's own lists; returns a normalized copy.
// internalEmails: our own addresses (intake mailbox, senders), whose domains never count as client contacts.
export function validate(
  input: LeadPayload,
  reference: Reference,
  mailText: string,
  internalEmails: string[] = [],
): ValidateResult {
  const shape = PayloadShape.safeParse(input);
  if (!shape.success) return { ok: false, reason: `Unexpected payload fields: ${shape.error.issues[0]?.message}` };
  const payload: LeadPayload = { ...shape.data };

  if (!payload.companyName.trim()) return { ok: false, reason: "No client company name found" };
  if (!payload.email && !payload.mobile) return { ok: false, reason: "No client email or mobile in the mail" };

  const text = mailText.toLowerCase();
  const internalDomains = new Set([...reference.users.map((u) => u.email), ...internalEmails].map((e) => e.split("@")[1]));

  if (payload.email) {
    const email = payload.email.trim().toLowerCase();
    if (!text.includes(email)) return { ok: false, reason: `Email ${email} does not appear in the mail` };
    if (internalDomains.has(email.split("@")[1])) {
      return { ok: false, reason: `Email ${email} is an internal address, not the client's` };
    }
    payload.email = email;
  }

  if (payload.mobile) {
    const checked = checkMobile(payload.mobile, payload.mobileCountryCode, mailText);
    if (typeof checked === "string") return { ok: false, reason: checked };
    payload.mobile = checked.mobile;
    payload.mobileCountryCode = checked.code;
  }

  if (!payload.salesPersonEmails.length) return { ok: false, reason: "No salesperson named to handle the lead" };
  const users = new Map(reference.users.map((u) => [u.email.toLowerCase(), u.email]));
  const salesPersonEmails: string[] = [];
  for (const raw of payload.salesPersonEmails) {
    const email = users.get(raw.trim().toLowerCase());
    if (!email) return { ok: false, reason: `Unknown salesperson: ${raw}` };
    if (!salesPersonEmails.includes(email)) salesPersonEmails.push(email);
  }
  payload.salesPersonEmails = salesPersonEmails;

  if (payload.services) {
    const services = new Map(reference.services.map((s) => [s.toLowerCase(), s]));
    const canonical: string[] = [];
    for (const raw of payload.services) {
      const name = services.get(raw.trim().toLowerCase());
      if (!name) return { ok: false, reason: `Unknown service: ${raw}` };
      if (!canonical.includes(name)) canonical.push(name);
    }
    payload.services = canonical;
  }

  return { ok: true, payload };
}
