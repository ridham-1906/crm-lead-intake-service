import { describe, expect, it } from "vitest";
import { toReference, type LeadPayload, type Reference } from "../src/crm.js";
import { normalizeMobile, validate } from "../src/validate.js";
import { fixture } from "./helpers.js";

const reference: Reference = {
  users: [
    { name: "Priya Shah", email: "priya@excellentpublicity.com" },
    { name: "Ravi Kumar", email: "ravi@excellentpublicity.com" },
  ],
  services: ["Radio", "Hoardings"],
};
const mailText = fixture("forwarded-inquiry.txt");

const good: LeadPayload = {
  companyName: "Sunrise Foods Pvt Ltd",
  email: "Anita.Rao@sunrisefoods.in",
  mobile: "9876543210",
  mobileCountryCode: "+91",
  source: "Email inquiry",
  services: ["radio"],
  salesPersonEmails: ["Priya@excellentpublicity.com"],
};

describe("validate", () => {
  it("accepts and normalizes a good payload", () => {
    const result = validate(good, reference, mailText);
    expect(result).toEqual({
      ok: true,
      payload: {
        ...good,
        email: "anita.rao@sunrisefoods.in",
        services: ["Radio"],
        salesPersonEmails: ["priya@excellentpublicity.com"],
      },
    });
  });

  it("rejects an email not in the mail", () => {
    const result = validate({ ...good, email: "anita@sunrisefoods.com" }, reference, mailText);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("does not appear") });
  });

  it("rejects a mobile not in the mail", () => {
    const result = validate({ ...good, email: undefined, mobile: "9876543211" }, reference, mailText);
    expect(result.ok).toBe(false);
  });

  it("rejects an internal email as the client contact", () => {
    const text = `${mailText}\npriya@excellentpublicity.com`;
    const result = validate({ ...good, email: "priya@excellentpublicity.com" }, reference, text);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("internal") });
  });

  it("requires a contact", () => {
    const result = validate({ ...good, email: undefined, mobile: undefined }, reference, mailText);
    expect(result).toMatchObject({ ok: false, reason: "No client email or mobile in the mail" });
  });

  it("rejects unknown salespeople and services", () => {
    expect(validate({ ...good, salesPersonEmails: ["x@excellentpublicity.com"] }, reference, mailText).ok).toBe(false);
    expect(validate({ ...good, salesPersonEmails: [] }, reference, mailText).ok).toBe(false);
    expect(validate({ ...good, services: ["TV"] }, reference, mailText).ok).toBe(false);
  });

  it("rejects unknown keys", () => {
    const withExtra = { ...good, status: "new" } as LeadPayload;
    expect(validate(withExtra, reference, mailText).ok).toBe(false);
  });

  it("rejects a missing company name", () => {
    expect(validate({ ...good, companyName: "  " }, reference, mailText).ok).toBe(false);
  });
});

describe("normalizeMobile", () => {
  it("strips dial code and trunk zero", () => {
    expect(normalizeMobile("+91 98765 43210", "+91")).toBe("9876543210");
    expect(normalizeMobile("098765-43210", "+91")).toBe("9876543210");
  });

  it("strips a short foreign dial code only when the mail writes it with +", () => {
    expect(normalizeMobile("6591234567", "+65", "Call +65 9123 4567")).toBe("91234567");
    expect(normalizeMobile("6591234567", "+65", "Call 6591234567")).toBe("6591234567");
  });
});

describe("international mobiles", () => {
  const contact = (mobile: string, mobileCountryCode?: string) => ({ ...good, email: undefined, mobile, mobileCountryCode });

  it("accepts a UAE number and takes the dial code from the mail", () => {
    const text = `${mailText}\nWhatsApp: +971 50 123 4567`;
    const result = validate(contact("501234567", undefined), reference, text);
    expect(result).toMatchObject({ ok: true, payload: { mobile: "501234567", mobileCountryCode: "+971" } });
  });

  it("corrects an AI that tagged a foreign number as +91", () => {
    const text = `${mailText}\nMobile: +44 7911 123456`;
    const result = validate(contact("7911123456", "+91"), reference, text);
    expect(result).toMatchObject({ ok: true, payload: { mobile: "7911123456", mobileCountryCode: "+44" } });
  });

  it("handles a dial code the AI left in the number", () => {
    const text = `${mailText}\nPh: +65 9123 4567`;
    const result = validate(contact("6591234567", "+65"), reference, text);
    expect(result).toMatchObject({ ok: true, payload: { mobile: "91234567", mobileCountryCode: "+65" } });
  });

  it("handles a trunk zero written after the dial code", () => {
    const text = `${mailText}\nTel: +44 (0)7911 123456`;
    const result = validate(contact("07911123456", "+44"), reference, text);
    expect(result).toMatchObject({ ok: true, payload: { mobile: "7911123456", mobileCountryCode: "+44" } });
  });

  it("still applies the Indian rule to +91 numbers", () => {
    const text = `${mailText}\n+91 12345 67890`;
    expect(validate(contact("1234567890", "+91"), reference, text)).toMatchObject({ ok: false });
  });
});

describe("toReference", () => {
  it("uses users when present", () => {
    const ref = toReference({ data: { users: [{ name: "Priya Shah", email: "Priya@x.com" }], services: [{ name: "Radio" }] } });
    expect(ref).toEqual({ users: [{ name: "Priya Shah", email: "priya@x.com" }], services: ["Radio"] });
  });

  it("falls back to salesPersons", () => {
    const ref = toReference({ data: { salesPersons: ["priya@x.com"] } });
    expect(ref.users).toEqual([{ name: "priya", email: "priya@x.com" }]);
  });
});
