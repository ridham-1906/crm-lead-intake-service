import { describe, expect, it } from "vitest";
import { modelOrder } from "../src/ai.js";
import { buildUserMessage, interpret, parseJsonContent, readAnswer, recipientAssignees, SOURCE, systemPrompt } from "../src/extract.js";
import { parseMessage } from "../src/mail.js";
import { fixture, gmailMessage } from "./helpers.js";

describe("buildUserMessage", () => {
  it("lists users and services before the mail", () => {
    const mail = parseMessage(gmailMessage({ body: fixture("no-contact.txt") }));
    const msg = buildUserMessage(mail, {
      users: [{ name: "Ravi Kumar", email: "ravi@excellentpublicity.com" }],
      services: ["Hoardings"],
    });
    expect(msg.indexOf("Ravi Kumar <ravi@excellentpublicity.com>")).toBeLessThan(msg.indexOf("<mail>"));
    expect(msg).toContain("- Hoardings");
    expect(msg).toContain("Bluefin Logistics");
  });
});

describe("interpret", () => {
  const lead = {
    companyName: " Sunrise Foods ",
    email: "",
    mobile: "9876543210",
    mobileCountryCode: null,
    contactName: null,
    designation: null,
    city: null,
    budget: null,
    notes: "Diwali radio",
    services: [],
    salesPersonEmails: ["Priya@excellentpublicity.com"],
  };

  it("maps a create decision to a clean payload", () => {
    expect(interpret({ decision: "create", reviewCode: null, reason: null, lead })).toEqual({
      ok: true,
      payload: {
        companyName: "Sunrise Foods",
        mobile: "9876543210",
        mobileCountryCode: "+91",
        notes: "Diwali radio",
        source: SOURCE,
        salesPersonEmails: ["priya@excellentpublicity.com"],
      },
    });
  });

  it("keeps the draft on review", () => {
    const result = interpret({ decision: "review", reviewCode: "multiple_companies", reason: "Two users named Priya", lead });
    expect(result).toMatchObject({ ok: false, reason: "Two users named Priya", draft: { companyName: "Sunrise Foods" } });
  });

  it("reviews when there is no lead", () => {
    expect(interpret({ decision: "create", reviewCode: null, reason: null, lead: null })).toMatchObject({ ok: false });
  });
});

describe("modelOrder", () => {
  const groq = ["g1", "g2"];
  const openrouter = ["o1:free", "o2:free"];

  it("puts every Groq model before any OpenRouter model", () => {
    const order = modelOrder(groq, openrouter, "fallback");
    expect(order.map((t) => `${t.provider}:${t.model}`)).toEqual(["groq:g1", "groq:g2", "openrouter:o1:free", "openrouter:o2:free"]);
  });

  it("rotates within each provider in round-robin mode", () => {
    const a = modelOrder(groq, openrouter, "round-robin");
    const b = modelOrder(groq, openrouter, "round-robin");
    expect(a[0]?.model).not.toBe(b[0]?.model);
    expect(a[0]?.provider).toBe("groq");
    expect(b[0]?.provider).toBe("groq");
  });

  it("works with only one provider configured", () => {
    expect(modelOrder([], openrouter, "fallback").map((t) => t.provider)).toEqual(["openrouter", "openrouter"]);
  });
});

describe("parseJsonContent", () => {
  it("ignores think blocks, fences and surrounding text", () => {
    expect(parseJsonContent('<think>hmm {not this}</think>\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('Here you go: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
  });

  it("throws when there is no object", () => {
    expect(() => parseJsonContent("no json here")).toThrow();
  });
});

describe("readAnswer", () => {
  it("flags truncated and malformed answers as unusable", () => {
    expect(readAnswer({ content: "{}", finishReason: "length" })).toMatchObject({ ok: false });
    expect(readAnswer({ content: '{"decision":"maybe"}', finishReason: "stop" })).toMatchObject({ ok: false });
  });
});

describe("systemPrompt", () => {
  it("uses the configured company name", () => {
    const prompt = systemPrompt("Acme Media");
    expect(prompt).toContain("Never use Acme Media");
    expect(prompt).not.toContain("{{");
  });
});

describe("recipientAssignees", () => {
  const reference = {
    users: [
      { name: "Priya Shah", email: "priya@excellentpublicity.com" },
      { name: "Ravi Kumar", email: "ravi@excellentpublicity.com" },
      { name: "Lead Gen", email: "man@excellentpublicity.com" },
    ],
    services: [],
  };
  const mailTo = (to: string, cc = "") =>
    parseMessage(gmailMessage({ body: "Fwd thread", headers: { To: to, ...(cc ? { Cc: cc } : {}) } }));

  it("assigns the To: recipients who are CRM users", () => {
    const mail = mailTo("Priya <Priya@excellentpublicity.com>, ravi@excellentpublicity.com, client@acme.com");
    expect(recipientAssignees(mail, reference, [])).toEqual(["priya@excellentpublicity.com", "ravi@excellentpublicity.com"]);
  });

  it("leaves out the lead generator, intake mailbox and sender", () => {
    const mail = mailTo("man@excellentpublicity.com, priya@excellentpublicity.com, leads@x.com");
    expect(recipientAssignees(mail, reference, ["man@excellentpublicity.com", "leads@x.com"])).toEqual(["priya@excellentpublicity.com"]);
  });

  it("ignores Cc", () => {
    const mail = mailTo("leads@x.com", "ravi@excellentpublicity.com");
    expect(recipientAssignees(mail, reference, ["leads@x.com"])).toEqual([]);
  });

  it("tells the AI who is assigned", () => {
    const mail = mailTo("priya@excellentpublicity.com");
    expect(buildUserMessage(mail, reference, ["priya@excellentpublicity.com"])).toContain("<assignees>\npriya@excellentpublicity.com\n</assignees>");
    expect(buildUserMessage(mail, reference)).not.toContain("<assignees>");
  });
});
