// Rebuilds a Mail and the CRM reference from a DEBUG_DUMP file (examples/<gmail-id>.txt).
import type { Reference } from "../src/crm.js";
import { extractAddress, extractAddresses, type Mail } from "../src/mail.js";

function section(text: string, title: string): string {
  const start = text.indexOf(`===== ${title}`);
  if (start < 0) return "";
  const from = text.indexOf("\n", start) + 1;
  const next = text.indexOf("\n===== ", from);
  return text.slice(from, next < 0 ? undefined : next);
}

function field(block: string, name: string): string {
  return block.match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
}

export function parseDump(id: string, text: string): { mail: Mail; reference: Reference } {
  const received = section(text, "Mail received");
  const bodyStart = received.indexOf("\n", received.indexOf("Body chars:")) + 1;
  const fromHeader = field(received, "From");
  const mail: Mail = {
    id,
    threadId: id,
    labelIds: [],
    messageIdHeader: "",
    from: extractAddress(fromHeader),
    fromHeader,
    to: extractAddresses(field(received, "To")),
    cc: extractAddresses(field(received, "Cc")),
    subject: field(received, "Subject"),
    date: field(received, "Date"),
    body: received.slice(bodyStart).trim(),
    authResults: [],
  };

  const input = section(text, "AI input");
  const block = (tag: string) => input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1]?.split("\n") ?? [];
  const users = block("users")
    .map((l) => l.match(/^(.*?)\s*<([^>]+)>$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1] ?? "", email: (m[2] ?? "").toLowerCase() }));
  // Newer dumps carry only <assignees>; those people are the users this replay needs.
  for (const email of block("assignees")) if (!users.some((u) => u.email === email)) users.push({ name: email.split("@")[0] ?? email, email });
  const services = block("services").map((l) => l.replace(/^- /, "").trim()).filter(Boolean);

  // fetchedAt far in the future: the replay never asks the CRM for fresh lists.
  return { mail, reference: { users, services, fetchedAt: Number.MAX_SAFE_INTEGER } };
}
