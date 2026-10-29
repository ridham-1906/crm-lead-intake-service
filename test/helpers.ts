import { readFileSync } from "node:fs";
import type { gmail_v1 } from "googleapis";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export function gmailMessage(opts: {
  body: string;
  html?: string;
  headers?: Record<string, string | string[]>;
}): gmail_v1.Schema$Message {
  const headers = Object.entries({
    From: "Co Founder <cofounder@excellentpublicity.com>",
    To: "leads@excellentpublicity.com",
    Subject: "Fwd: Radio campaign for Diwali",
    Date: "Mon, 26 Oct 2026 11:30:00 +0530",
    "Message-ID": "<abc123@mail.gmail.com>",
    ...opts.headers,
  }).flatMap(([name, v]) => (Array.isArray(v) ? v : [v]).map((value) => ({ name, value })));

  const parts: gmail_v1.Schema$MessagePart[] = [
    { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }], body: { data: b64(opts.body) } },
  ];
  if (opts.html) parts.push({ mimeType: "text/html", body: { data: b64(opts.html) } });

  return {
    id: "msg1",
    threadId: "thr1",
    labelIds: ["INBOX"],
    payload: { mimeType: "multipart/alternative", headers, parts },
  };
}
