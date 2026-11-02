import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanThread, companyFromDomain, fitBody, isOurDomain, threadHints } from "../src/thread.js";
import { parseDump } from "../scripts/example-dump.js";

// Only what the service knows without configuration: the CRM users' domain. Outreach domains must be learned.
const OURS = ["excellentpublicity.com"];
const COMPANY = "Excellent Publicity";
const STEM = "excellentpublicity";

describe("cleanThread", () => {
  it("drops quote markers, link fragments, dial-ins, our footer and repeated paragraphs", () => {
    const pitch = "Hi Daya,\nA limited opportunity has opened up for Venus Rent a Car in IndiGo's inflight magazine.";
    const body = [
      "> Thanks,",
      "",
      "Feel free to contact us in case of any query.",
      "",
      "[image: Atlas by Excellent Publicity]",
      "Or dial: (US) +1 575-689-8788 <(575)%20689-8788> PIN: 798 269 061#",
      "",
      pitch,
      "",
      `> ${pitch.replace("\n", "\n> ")}`,
      "",
      "(M) +919979915070 <+91%2099799%2015070>",
    ].join("\n");
    const cleaned = cleanThread(body);
    expect(cleaned).not.toMatch(/Feel free|image:|Or dial|%20/);
    expect(cleaned.match(/limited opportunity/g)).toHaveLength(1);
    expect(cleaned).toContain("(M) +919979915070");
  });

  it("keeps the start and end of a long thread", () => {
    const text = `START${"x".repeat(50_000)}END`;
    const fitted = fitBody(text, 1000);
    expect(fitted.startsWith("START")).toBe(true);
    expect(fitted.endsWith("END")).toBe(true);
    expect(fitted.length).toBeLessThan(1100);
  });
});

describe("domains", () => {
  it("treats configured domains and brand look-alikes as ours", () => {
    expect(isOurDomain("excellentpublicityooh.com", [], STEM)).toBe(true);
    expect(isOurDomain("mail.thecreativewonder.com", ["thecreativewonder.com"])).toBe(true);
    expect(isOurDomain("safeinvest.co.in", OURS, STEM)).toBe(false);
  });

  it("guesses a company from a business domain only", () => {
    expect(companyFromDomain("safeinvest.co.in")).toBe("Safeinvest");
    expect(companyFromDomain("primaluxury.com")).toBe("Primaluxury");
    expect(companyFromDomain("gmail.com")).toBeUndefined();
  });
});

// The real threads in examples/ are not committed with the code; these checks run only where they exist.
const hasExamples = existsSync("examples/1a18b59aad879e4e.txt");
const hints = (id: string) => threadHints(parseDump(id, readFileSync(`examples/${id}.txt`, "utf8")).mail, OURS, COMPANY);

describe.skipIf(!hasExamples)("threadHints on real threads", () => {
  it("SAFEinvest: client first, Meet dial-in is ours, mobile line kept", () => {
    const h = hints("1a18b59aad879e4e");
    expect(h.outsideParticipants[0]).toMatchObject({ email: "jiga.maniar@safeinvest.co.in", name: "Jiga Maniar" });
    expect(h.ourPhones).toContain("5756898788");
    expect(h.phoneLines.some((l) => l.includes("(M) +919979915070"))).toBe(true);
  });

  it("JK Group: our salesperson's personal number is ours", () => {
    expect(hints("1a18b8aec9948936").ourPhones).toEqual(expect.arrayContaining(["9898597813", "7600623456"]));
  });

  it("GSIS: a signature-only client still has a named contact", () => {
    expect(hints("1a18b7803150ad35").outsideParticipants[0]).toMatchObject({ email: "digitalmarketing@gsis.ac.in", name: "Vinola Hilary" });
  });

  it("Venus: an unlisted outreach domain is learned from its signature, not mistaken for the client", () => {
    const h = hints("1a18b925e0027b8f");
    expect(h.outsideParticipants.map((p) => p.email)).toEqual(["daya@venusrentacar.com"]);
    expect(h.ourDomains).toContain("thecreativewonder.com");
    expect(h.ourPeople.find((p) => p.email === "pratham@thecreativewonder.com")?.why).toBeTruthy();
  });

  it("a client who merely mentions us or writes to inquiry@ stays the client", () => {
    const h = hints("1a18b59aad879e4e");
    expect(h.ourPeople.map((p) => p.email)).not.toContain("jiga.maniar@safeinvest.co.in");
    expect(h.outsideParticipants[0]?.messages).toBeGreaterThan(0);
  });
});
