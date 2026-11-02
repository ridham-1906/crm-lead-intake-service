import type { gmail_v1 } from "googleapis";

// Raw cap only; the AI sees the cleaned thread, trimmed to PROMPT_BODY_LIMIT in thread.ts.
export const BODY_LIMIT = 100_000;

export type Mail = {
  id: string;
  threadId: string;
  labelIds: string[];
  messageIdHeader: string;
  from: string;
  fromHeader: string;
  to: string[];
  cc: string[];
  subject: string;
  date: string;
  body: string;
  authResults: string[];
};

type Part = gmail_v1.Schema$MessagePart;

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function extractAddresses(value: string): string[] {
  return [...new Set((value.match(EMAIL_RE) ?? []).map((a) => a.toLowerCase()))];
}

// The address inside <...> wins over any address-like text in the display name.
export function extractAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  const candidate = angle?.[1] ?? value;
  return extractAddresses(candidate)[0] ?? "";
}

function headerValues(part: Part | undefined, name: string): string[] {
  const lower = name.toLowerCase();
  return (part?.headers ?? [])
    .filter((h) => h.name?.toLowerCase() === lower)
    .map((h) => h.value ?? "");
}

function header(part: Part | undefined, name: string): string {
  return headerValues(part, name)[0] ?? "";
}

function decodePart(part: Part): string {
  const data = part.body?.data;
  if (!data) return "";
  const charset = header(part, "Content-Type").match(/charset="?([^";\s]+)"?/i)?.[1] ?? "utf-8";
  const bytes = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Depth-first search for the first inline (non-attachment) part of a MIME type.
function findPart(part: Part | undefined, mimeType: string): Part | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseMessage(msg: gmail_v1.Schema$Message): Mail {
  const root = msg.payload;
  const plain = findPart(root, "text/plain");
  const html = findPart(root, "text/html");
  const body = plain ? decodePart(plain).trim() : html ? htmlToText(decodePart(html)) : "";
  const fromHeader = header(root, "From");

  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    labelIds: msg.labelIds ?? [],
    messageIdHeader: header(root, "Message-ID"),
    from: extractAddress(fromHeader),
    fromHeader,
    to: extractAddresses(header(root, "To")),
    cc: extractAddresses(header(root, "Cc")),
    subject: header(root, "Subject"),
    date: header(root, "Date"),
    body: body.slice(0, BODY_LIMIT),
    authResults: headerValues(root, "Authentication-Results"),
  };
}

// Text the extracted contact details must appear in.
export function searchableText(mail: Mail): string {
  return [mail.subject, mail.to.join(" "), mail.cc.join(" "), mail.body].join("\n");
}

function domainOf(address: string): string {
  return address.split("@")[1]?.toLowerCase() ?? "";
}

function sameOrSubdomain(candidate: string, domain: string): boolean {
  const c = candidate.toLowerCase().replace(/^@/, "");
  return c === domain || c.endsWith(`.${domain}`);
}

// True when Gmail's own Authentication-Results header shows DMARC pass, or SPF + DKIM pass, for the sender's domain.
export function isSenderAuthenticated(mail: Mail): boolean {
  const domain = domainOf(mail.from);
  if (!domain) return false;
  const gmailResults = mail.authResults.filter((h) => h.trim().toLowerCase().startsWith("mx.google.com"));

  return gmailResults.some((h) => {
    const dmarc = h.match(/dmarc=pass\b[^;]*?header\.from=([^\s;)]+)/i);
    if (dmarc?.[1] && sameOrSubdomain(dmarc[1], domain)) return true;

    const spf = h.match(/spf=pass\b[^;]*?smtp\.mailfrom=([^\s;)]+)/i);
    const spfOk = !!spf?.[1] && sameOrSubdomain(domainOf(spf[1]) || spf[1], domain);
    const dkimOk = [...h.matchAll(/dkim=pass\b[^;]*?header\.(?:i|d)=([^\s;)]+)/gi)].some(
      (m) => !!m[1] && sameOrSubdomain(m[1].includes("@") ? domainOf(m[1]) : m[1], domain),
    );
    return spfOk && dkimOk;
  });
}

function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

export type Attachment = { filename: string; contentType: string; base64: string };

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  attachment?: Attachment;
};

// Builds an RFC 2822 message and returns it base64url-encoded, as users.messages.send expects.
export function buildRawMail(m: OutgoingMail): string {
  const headers = [`To: ${m.to}`, `Subject: ${encodeHeader(m.subject)}`, "MIME-Version: 1.0"];
  if (m.inReplyTo) headers.push(`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`);

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(m.text, "utf8").toString("base64")),
  ].join("\r\n");

  let raw: string;
  if (m.attachment) {
    const boundary = `ep-lead-intake-${Date.now().toString(36)}`;
    raw = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      textPart,
      `--${boundary}`,
      `Content-Type: ${m.attachment.contentType}; name="${m.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${m.attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(m.attachment.base64),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    raw = [...headers, textPart, ""].join("\r\n");
  }
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function forwardSubject(subject: string): string {
  return /^(fwd?|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
}
