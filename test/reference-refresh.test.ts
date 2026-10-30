import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reference } from "../src/crm.js";
import { unknownColleagues } from "../src/extract.js";
import { parseMessage } from "../src/mail.js";
import { fixture, gmailMessage } from "./helpers.js";

const oldRef: Reference = {
  users: [{ name: "Priya Shah", email: "priya@excellentpublicity.com" }],
  services: ["Radio"],
  fetchedAt: Date.now() - 60_000,
};
const freshBody = {
  data: {
    users: [
      { name: "Priya Shah", email: "priya@excellentpublicity.com" },
      { name: "Neha New", email: "neha@excellentpublicity.com" },
    ],
    services: [{ name: "Radio" }, { name: "Podcast" }],
  },
};

const aiAnswer = (salesPersonEmails: string[], services: string[]) =>
  new Response(
    JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            decision: "create",
            reviewCode: null,
            reason: null,
            lead: {
              companyName: "Sunrise Foods Pvt Ltd", email: null, mobile: "9876543210", mobileCountryCode: "+91",
              contactName: null, designation: null, city: null, budget: null, notes: null, services, salesPersonEmails,
            },
          }),
        },
      }],
    }),
  );

describe("unknownColleagues", () => {
  it("flags To: addresses on our domain that the reference doesn't know", () => {
    const mail = parseMessage(gmailMessage({ body: "x", headers: { To: "neha@excellentpublicity.com, priya@excellentpublicity.com, a@client.com" } }));
    expect(unknownColleagues(mail, oldRef, [], [])).toEqual(["neha@excellentpublicity.com"]);
  });
});

describe("draftLead reference refresh", () => {
  let crmCalls = 0;
  beforeEach(() => {
    vi.resetModules();
    crmCalls = 0;
    for (const [k, v] of Object.entries({
      INTAKE_MAILBOX: "leads@x.com", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "a", GMAIL_REFRESH_TOKEN: "a",
      GMAIL_PUBSUB_TOPIC: "projects/p/topics/t", PUBSUB_AUDIENCE: "https://x.com/gmail/push",
      PUBSUB_SERVICE_ACCOUNT: "sa@p.iam.gserviceaccount.com", CRM_URL: "https://crm.test", LEAD_IMPORT_API_KEY: "k",
      ALLOWED_SENDERS: "cofounder@excellentpublicity.com", LEAD_GENERATOR_EMAIL: "lg@excellentpublicity.com",
      ALERT_EMAIL: "al@x.com", GROQ_API_KEY: "g", GROQ_MODELS: "m", OPENROUTER_MODELS: "", DEBUG_DUMP: "false",
    })) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const stub = (ai: () => Response) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("https://crm.test")) {
        crmCalls++;
        return new Response(JSON.stringify(freshBody));
      }
      return ai();
    }));

  it("refreshes before the AI when To: has a colleague the cache doesn't know", async () => {
    stub(() => aiAnswer([], []));
    const { draftLead } = await import("../src/process.js");
    const mail = parseMessage(gmailMessage({ body: fixture("forwarded-inquiry.txt"), headers: { To: "neha@excellentpublicity.com" } }));
    const result = await draftLead(mail, oldRef);
    expect(crmCalls).toBe(1);
    expect(result).toMatchObject({ ok: true, payload: { salesPersonEmails: ["neha@excellentpublicity.com"] } });
  });

  it("refreshes after an unknown-service failure and re-checks without asking the AI again", async () => {
    let aiCalls = 0;
    stub(() => {
      aiCalls++;
      return aiAnswer(["priya@excellentpublicity.com"], ["Podcast"]);
    });
    const { draftLead } = await import("../src/process.js");
    const mail = parseMessage(gmailMessage({ body: `${fixture("forwarded-inquiry.txt")}\nAlso a podcast.` }));
    const result = await draftLead(mail, oldRef);
    expect(crmCalls).toBe(1);
    expect(aiCalls).toBe(1);
    expect(result).toMatchObject({ ok: true, payload: { services: ["Podcast"] } });
  });

  it("still sends to review when the fresh lists don't have it either", async () => {
    stub(() => aiAnswer(["ghost@excellentpublicity.com"], []));
    const { draftLead } = await import("../src/process.js");
    const mail = parseMessage(gmailMessage({ body: fixture("forwarded-inquiry.txt") }));
    const result = await draftLead(mail, oldRef);
    expect(crmCalls).toBe(1);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Unknown salesperson") });
  });
});
