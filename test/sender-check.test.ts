import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMessage } from "../src/mail.js";
import { gmailMessage } from "./helpers.js";

const SECRET = "crm+test-tag@excellentpublicity.co";
const DMARC_PASS = "mx.google.com; dmarc=pass (p=NONE) header.from=excellentpublicity.com";

describe("senderCheck", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries({
      INTAKE_MAILBOX: "crm@excellentpublicity.co", GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "a", GMAIL_REFRESH_TOKEN: "a",
      GMAIL_PUBSUB_TOPIC: "projects/p/topics/t", PUBSUB_AUDIENCE: "https://x.com/gmail/push",
      PUBSUB_SERVICE_ACCOUNT: "sa@p.iam.gserviceaccount.com", CRM_URL: "https://crm.test", LEAD_IMPORT_API_KEY: "k",
      ALLOWED_SENDERS: "cofounder@excellentpublicity.com", LEAD_GENERATOR_EMAIL: "lg@excellentpublicity.com",
      SECRET_INTAKE_ADDRESS: SECRET.toUpperCase(), ALERT_EMAIL: "al@x.com", GROQ_API_KEY: "g", GROQ_MODELS: "m",
    })) vi.stubEnv(k, v);
  });
  afterEach(() => vi.unstubAllEnvs());

  const outsider = (headers: Record<string, string | string[]>) =>
    parseMessage(gmailMessage({ body: "x", headers: { From: "Rep <rep@growwithep.com>", To: "priya@excellentpublicity.com", ...headers } }));

  it("accepts any sender that Bcc'd the secret address", async () => {
    const { senderCheck } = await import("../src/process.js");
    expect(senderCheck(outsider({ "Delivered-To": SECRET }))).toBeUndefined();
  });

  it("ignores the secret address in To or Cc", async () => {
    const { senderCheck } = await import("../src/process.js");
    expect(senderCheck(outsider({ To: SECRET, "Delivered-To": SECRET }))).toBe("secret address must be in Bcc");
    expect(senderCheck(outsider({ Cc: SECRET, "Delivered-To": SECRET }))).toBe("secret address must be in Bcc");
  });

  it("ignores a wrong tag and a fake Delivered-To below Gmail's own", async () => {
    const { senderCheck } = await import("../src/process.js");
    expect(senderCheck(outsider({ "Delivered-To": "crm+guess@excellentpublicity.co" }))).toBe("sender not on the allowlist");
    expect(senderCheck(outsider({ "Delivered-To": ["crm@excellentpublicity.co", SECRET] }))).toBe("sender not on the allowlist");
  });

  it("still accepts an authenticated allowlisted sender", async () => {
    const { senderCheck } = await import("../src/process.js");
    const mail = parseMessage(gmailMessage({ body: "x", headers: { "Authentication-Results": DMARC_PASS } }));
    expect(senderCheck(mail)).toBeUndefined();
  });

  it("rejects a secret address equal to the intake mailbox", async () => {
    vi.stubEnv("SECRET_INTAKE_ADDRESS", "crm@excellentpublicity.co");
    const { getEnv } = await import("../src/env.js");
    expect(() => getEnv()).toThrow(/SECRET_INTAKE_ADDRESS/);
  });
});
