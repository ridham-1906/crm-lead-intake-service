import { getEnv } from "./env.js";

export type User = { name: string; email: string };
export type Reference = { users: User[]; services: string[]; fetchedAt?: number };

export type LeadPayload = {
  companyName: string;
  email?: string;
  mobile?: string;
  mobileCountryCode?: string;
  contactName?: string;
  designation?: string;
  city?: string;
  budget?: string;
  notes?: string;
  source: string;
  services?: string[];
  salesPersonEmails: string[];
};

export type CreateResult =
  | { kind: "created"; leadId: number; client: string; salesPersons: string[] }
  | { kind: "rejected"; status: number; error: string };

// Our fault, not the mail's (auth, CRM down, network): the mail is left for the next run.
export class CrmUnavailableError extends Error {}

const REFERENCE_TTL_MS = 5 * 60 * 1000;
let referenceCache: { at: number; value: Reference } | undefined;

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const env = getEnv();
  let res: Response;
  try {
    res = await fetch(`${env.CRM_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.LEAD_IMPORT_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new CrmUnavailableError(`CRM request failed: ${(err as Error).message}`);
  }
  const body: unknown = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

function errorText(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === "string" ? error : undefined;
}

type ReferenceBody = {
  data?: {
    salesPersons?: string[];
    services?: { name: string }[];
    users?: User[];
  };
};

// Builds the reference lists, falling back to salesPersons emails when the CRM has no users list yet.
export function toReference(body: ReferenceBody): Reference {
  const data = body.data ?? {};
  const users = data.users?.length
    ? data.users.map((u) => ({ name: u.name, email: u.email.toLowerCase() }))
    : (data.salesPersons ?? []).map((email) => ({ name: email.split("@")[0] ?? email, email: email.toLowerCase() }));
  const services = (data.services ?? []).map((s) => s.name);
  return { users, services };
}

// Cached for 5 minutes; pass maxAgeMs = 0 to force a fresh fetch.
export async function getReference(maxAgeMs = REFERENCE_TTL_MS): Promise<Reference> {
  if (referenceCache && Date.now() - referenceCache.at < maxAgeMs) return referenceCache.value;
  const { status, body } = await call("/api/leads/bulk-create/reference");
  if (status !== 200) {
    throw new CrmUnavailableError(`CRM reference returned ${status}: ${errorText(body) ?? "no error message"}`);
  }
  const at = Date.now();
  const value = { ...toReference(body as ReferenceBody), fetchedAt: at };
  if (!value.users.length) throw new CrmUnavailableError("CRM reference has no users");
  referenceCache = { at, value };
  return value;
}

export function invalidateReference(): void {
  referenceCache = undefined;
}

export async function createLead(payload: LeadPayload): Promise<CreateResult> {
  const { status, body } = await call("/api/leads/bulk-create", { method: "POST", body: JSON.stringify(payload) });

  if (status === 201) {
    const data = (body as { data?: { leadId?: number; client?: string; salesPersons?: string[] } }).data ?? {};
    if (typeof data.leadId !== "number") throw new CrmUnavailableError("CRM 201 response had no leadId");
    return { kind: "created", leadId: data.leadId, client: data.client ?? "", salesPersons: data.salesPersons ?? [] };
  }
  if (status === 400 || status === 409) {
    return { kind: "rejected", status, error: errorText(body) ?? `CRM refused the lead (${status})` };
  }
  throw new CrmUnavailableError(`CRM create returned ${status}: ${errorText(body) ?? "no error message"}`);
}
