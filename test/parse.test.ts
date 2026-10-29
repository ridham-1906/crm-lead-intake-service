import { describe, expect, it } from "vitest";
import {
  BODY_LIMIT,
  buildRawMail,
  extractAddress,
  htmlToText,
  isSenderAuthenticated,
  parseMessage,
  type Mail,
} from "../src/mail.js";
import { fixture, gmailMessage } from "./helpers.js";

const DMARC_PASS =
  "mx.google.com; dkim=pass header.i=@excellentpublicity.com header.s=google; spf=pass (google.com: domain of cofounder@excellentpublicity.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=cofounder@excellentpublicity.com; dmarc=pass (p=QUARANTINE) header.from=excellentpublicity.com";

describe("parseMessage", () => {
  it("extracts headers and keeps the forwarded block", () => {
    const mail = parseMessage(
      gmailMessage({ body: fixture("forwarded-inquiry.txt"), headers: { Cc: "Ravi K <Ravi@excellentpublicity.com>" } }),
    );
    expect(mail.from).toBe("cofounder@excellentpublicity.com");
    expect(mail.cc).toEqual(["ravi@excellentpublicity.com"]);
    expect(mail.subject).toBe("Fwd: Radio campaign for Diwali");
    expect(mail.messageIdHeader).toBe("<abc123@mail.gmail.com>");
    expect(mail.body).toContain("---------- Forwarded message ---------");
    expect(mail.body).toContain("anita.rao@sunrisefoods.in");
  });

  it("prefers text/plain over html", () => {
    const mail = parseMessage(gmailMessage({ body: "plain text", html: "<p>html text</p>" }));
    expect(mail.body).toBe("plain text");
  });

  it("falls back to stripped html", () => {
    const msg = gmailMessage({ body: "" });
    msg.payload!.parts = [{ mimeType: "text/html", body: { data: Buffer.from("<p>Hi&nbsp;there</p><br>Bye").toString("base64url") } }];
    expect(parseMessage(msg).body).toBe("Hi there\n\nBye");
  });

  it("caps the body", () => {
    const mail = parseMessage(gmailMessage({ body: "x".repeat(BODY_LIMIT + 500) }));
    expect(mail.body.length).toBe(BODY_LIMIT);
  });
});

describe("htmlToText", () => {
  it("drops styles and decodes entities", () => {
    expect(htmlToText("<style>p{}</style><div>A &amp; B &#8377;5</div>")).toBe("A & B ₹5");
  });
});

describe("extractAddress", () => {
  it("prefers the angle-bracket address", () => {
    expect(extractAddress('"fake@evil.com" <Real@Example.com>')).toBe("real@example.com");
    expect(extractAddress("plain@example.com")).toBe("plain@example.com");
  });
});

describe("isSenderAuthenticated", () => {
  const base = parseMessage(gmailMessage({ body: "x" }));
  const withAuth = (authResults: string[]): Mail => ({ ...base, authResults });

  it("accepts DMARC pass for the sender domain", () => {
    expect(isSenderAuthenticated(withAuth([DMARC_PASS]))).toBe(true);
  });

  it("accepts SPF + DKIM pass without DMARC", () => {
    const h = "mx.google.com; dkim=pass header.i=@excellentpublicity.com; spf=pass smtp.mailfrom=cofounder@excellentpublicity.com";
    expect(isSenderAuthenticated(withAuth([h]))).toBe(true);
  });

  it("rejects a pass for another domain", () => {
    const h = "mx.google.com; dkim=pass header.i=@evil.com; spf=pass smtp.mailfrom=x@evil.com; dmarc=pass header.from=evil.com";
    expect(isSenderAuthenticated(withAuth([h]))).toBe(false);
  });

  it("ignores results not added by Gmail", () => {
    expect(isSenderAuthenticated(withAuth([DMARC_PASS.replace("mx.google.com", "evil.example")]))).toBe(false);
  });

  it("rejects mail with no results", () => {
    expect(isSenderAuthenticated(withAuth([]))).toBe(false);
  });
});

describe("buildRawMail", () => {
  it("encodes a threaded reply", () => {
    const raw = Buffer.from(
      buildRawMail({ to: "a@b.com", subject: "Re: Hello ₹", text: "Lead #1", inReplyTo: "<x@y>" }),
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("To: a@b.com");
    expect(raw).toContain("In-Reply-To: <x@y>");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain(Buffer.from("Lead #1").toString("base64"));
  });
});
