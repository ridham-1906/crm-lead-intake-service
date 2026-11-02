import type { Mail } from "./mail.js";

export const PROMPT_BODY_LIMIT = 14_000;

// Our own boilerplate and generic legal text: dropped before the thread reaches the AI.
const BOILERPLATE = [
  /feel free to contact us in case of any query/i,
  /^thanking you/i,
  /member of bni/i,
  /a thousand people have every great idea/i,
  /irrational\s+persistence/i,
  /^-{10,}$/,
  /disclaimer/i,
  /confidential and may be\s+legally privileged/i,
  /if you are not the intended/i,
  /scanned for viruses/i,
  /cannot accept responsibility/i,
  /^sent from my (iphone|android|ipad)/i,
];

// Lines that are noise on their own: images, Meet dial-ins, bare links.
const NOISE_LINE = [/^\[image:[^\]]*\]$/i, /^<https?:\/\/[^>]*>\.?$/i, /^or dial:/i, /^more phone numbers:/i, /^google meet joining info$/i];

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "rediffmail.com", "aol.com", "protonmail.com", "proton.me", "zoho.com", "ymail.com", "msn.com",
]);

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{7,}\d/g;

const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";
const digits = (s: string) => s.replace(/\D/g, "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.+]+/g, " ").trim();

// The company name squashed into a domain-like stem: "Excellent Publicity" → "excellentpublicity".
export function brandStem(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Our domains: known ones (and their subdomains), plus any look-alike containing the brand stem.
export function isOurDomain(domain: string, ourDomains: string[], stem = ""): boolean {
  const d = domain.toLowerCase();
  return ourDomains.some((o) => d === o || d.endsWith(`.${o}`)) || (stem.length >= 5 && d.replace(/[^a-z0-9]/g, "").includes(stem));
}

// Removes quote markers, inline link/phone fragments, our boilerplate and every repeated paragraph.
export function cleanThread(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^(\s*>)+\s?/, "")
        .replace(/<(https?:|mailto:|tel:|\+?\(?\d)[^>]*>/gi, "")
        .replace(/\*/g, "")
        .replace(/[\u200e\u200f\u202a-\u202e\ufeff]/g, "")
        .trimEnd(),
    )
    .filter((l) => !NOISE_LINE.some((re) => re.test(l.trim())));

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of [...lines, ""]) {
    if (line.trim()) current.push(line);
    else if (current.length) {
      paragraphs.push(current.join("\n"));
      current = [];
    }
  }

  const seen = new Set<string>();
  const kept = paragraphs.filter((p) => {
    if (BOILERPLATE.some((re) => re.test(p.trim()))) return false;
    const key = norm(p);
    if (key.length >= 15 && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return kept.join("\n\n");
}

// Keeps the start (newest messages) and the end (the client's first reply and the pitch) of a long thread.
export function fitBody(text: string, limit = PROMPT_BODY_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n\n[… middle of the thread removed …]\n\n${text.slice(-half)}`;
}

export type Participant = { email: string; name?: string; mentions: number; messages: number };

export type ThreadHints = {
  stem: string;
  ourDomains: string[];
  ourPeople: { email: string; why: string }[];
  outsideParticipants: Participant[];
  companyGuess?: string;
  ourPhones: string[];
  phoneLines: string[];
};

// "safeinvest.co.in" → "Safeinvest"; free-mail domains give no guess.
export function companyFromDomain(domain: string): string | undefined {
  if (!domain || FREE_MAIL.has(domain)) return undefined;
  const labels = domain.split(".");
  const secondLevel = /^(co|com|ac|org|net|gov|edu)$/.test(labels.at(-2) ?? "") && labels.length > 2;
  const name = labels.at(secondLevel ? -3 : -2);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}

function displayNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  const re = /([A-Za-z][A-Za-z .'()-]{1,80}?)\s*<\s*([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*>/g;
  for (const m of text.matchAll(re)) {
    const name = m[1]
      ?.replace(/^(from|to|cc|wrote)\s*/i, "")
      .replace(/\([^)]*\)?/g, "")
      .trim();
    const email = m[2]?.toLowerCase();
    // A bare domain ("gsis.ac.in") is a link label, not a person's name.
    if (name && email && !names.has(email) && !/^[\w.-]+\.[a-z]{2,}$/i.test(name)) names.set(email, name);
  }
  return names;
}

// Phone-like numbers on a line, after dropping link fragments, URLs and Meet PINs that only look like phones.
function phonesIn(line: string): string[] {
  const text = line.replace(/<[^>]*>/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/pin:?\s*[\d\s#]+/gi, " ");
  return [...text.matchAll(PHONE_IN_TEXT)].map((m) => m[0]).filter((p) => digits(p).length >= 10);
}

export type Segment = { author: string; text: string };

const EMAIL_ONE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HEADER_LINE = /^\s*(from|sent|date|to|cc|bcc|subject)\s*:/i;

// Splits a thread into messages by their headers ("From: …" blocks and "On … <x> wrote:" lines) and names each author.
// Text before the first header was written by the forwarder.
export function splitMessages(body: string, forwarder: string): Segment[] {
  const text = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\s*>)+\s?/, "").replace(/\*/g, ""))
    .join("\n");
  const headers: { start: number; end: number; author: string }[] = [];

  for (const m of text.matchAll(/^[ \t]*from:[ \t]*[^\n@]*?<?\s*([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gim)) {
    // The header block runs to the first blank line (Sent/To/Cc/Subject lines are not the author's words).
    const blank = text.indexOf("\n\n", m.index);
    headers.push({ start: m.index, end: blank < 0 ? text.length : blank, author: (m[1] ?? "").toLowerCase() });
  }
  for (const m of text.matchAll(/wrote:/gi)) {
    const windowStart = Math.max(0, m.index - 300);
    const window = text.slice(windowStart, m.index);
    const on = [...window.matchAll(/\bOn\s/g)].at(-1);
    const author = on && window.slice(on.index).match(new RegExp(EMAIL_ONE.source, "g"))?.at(-1);
    if (on && author) headers.push({ start: windowStart + on.index, end: m.index + "wrote:".length, author: author.toLowerCase() });
  }

  headers.sort((a, b) => a.start - b.start);
  const segments: Segment[] = [{ author: forwarder.toLowerCase(), text: text.slice(0, headers[0]?.start ?? text.length) }];
  headers.forEach((h, i) => {
    const next = headers[i + 1]?.start ?? text.length;
    if (h.end < next) segments.push({ author: h.author, text: text.slice(h.end, next) });
  });
  return segments;
}

// Phrases our cold-email pitches use; two or more in one message mark the author as ours.
const PITCH = [
  /i can share a meeting link/i,
  /starting from\s*(₹|rs\.?|inr)?\s*\d/i,
  /we have (also )?(created|planned)/i,
  /\bepitch\b/i,
  /media packages/i,
  /(fresh|limited) opportunity has (come up|opened up)/i,
  /10-minute (call|discussion)/i,
  /advertise with us/i,
  /complimentary (media )?strategy report/i,
];

// Why this message reads as written by us, or undefined if it reads like a client's.
function ourMarker(text: string, company: string, stem: string): string | undefined {
  const words = text
    .split("\n")
    .filter((l) => !HEADER_LINE.test(l))
    .join("\n");
  const brand = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\s*${brand}\\s*$`, "im").test(words)) return `signature line "${company}"`;
  if (new RegExp(`\\[image:[^\\]]*${brand}[^\\]]*\\]`, "i").test(words)) return `"${company}" signature image`;
  if (/feel free to contact us in case of any query|member of bni/i.test(words)) return "our standard email footer";
  const ownAddressInSignature = words.split("\n").some((l) => phonesIn(l).length > 0 && l.toLowerCase().includes(`@`) && l.replace(/[^a-z0-9@]/gi, "").toLowerCase().includes(stem));
  if (stem && ownAddressInSignature) return "our address in their signature";
  const pitch = PITCH.filter((re) => re.test(words)).length;
  if (pitch >= 2) return "writes our sales pitch";
  return undefined;
}

// Facts the code can find reliably, handed to the AI as hints so it only has to confirm them.
// knownDomains are certain (CRM users, sender, intake mailbox); further domains are learned from who wrote what.
export function threadHints(mail: Mail, knownDomains: string[], company: string): ThreadHints {
  const stem = brandStem(company);
  const raw = [mail.fromHeader, mail.to.join(", "), mail.cc.join(", "), mail.body].join("\n");
  const names = displayNames(raw.replace(/\*/g, "").replace(/\n/g, " "));
  const segments = splitMessages(mail.body, mail.from);

  // Classify every author: known domain first, otherwise what their own messages say.
  const ourPeople = new Map<string, string>();
  const clientAuthors = new Map<string, number>();
  for (const s of segments) {
    if (ourPeople.has(s.author)) continue;
    const why = isOurDomain(domainOf(s.author), knownDomains, stem) ? "our domain" : ourMarker(s.text, company, stem);
    if (why) {
      ourPeople.set(s.author, why);
      clientAuthors.delete(s.author);
    } else clientAuthors.set(s.author, (clientAuthors.get(s.author) ?? 0) + 1);
  }
  const learned = [...ourPeople.keys()].map(domainOf).filter((d) => d && !FREE_MAIL.has(d));
  const ourDomains = [...new Set([...knownDomains, ...learned])];
  const isOurs = (email: string) => ourPeople.has(email) || isOurDomain(domainOf(email), ourDomains, stem);

  const counts = new Map<string, number>();
  for (const m of raw.matchAll(EMAIL_IN_TEXT)) {
    const email = m[0].toLowerCase();
    if (!isOurs(email)) counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  // People who actually wrote messages rank above people who were only copied or mentioned.
  const outsideParticipants = [...counts]
    .map(([email, mentions]) => ({ email, mentions, messages: clientAuthors.get(email) ?? 0, name: names.get(email) }))
    .sort((a, b) => b.messages - a.messages || b.mentions - a.mentions);

  const companyGuess = outsideParticipants.map((p) => companyFromDomain(domainOf(p.email))).find(Boolean);

  // Every phone in a message we wrote is ours, and so is any Meet dial-in; the client's lines are kept with their labels.
  const ourPhones = new Set<string>();
  const phoneLines: string[] = [];
  for (const s of segments) {
    const ours = isOurs(s.author);
    for (const line of s.text.split("\n")) {
      const phones = phonesIn(line);
      if (!phones.length || HEADER_LINE.test(line)) continue;
      const shown = line.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      if (ours || /or dial|pin:/i.test(line)) phones.forEach((p) => ourPhones.add(digits(p).slice(-10)));
      else if (!phoneLines.includes(shown)) phoneLines.push(shown);
    }
  }

  return {
    stem,
    ourDomains,
    ourPeople: [...ourPeople].map(([email, why]) => ({ email, why })),
    outsideParticipants: outsideParticipants.slice(0, 8),
    companyGuess,
    ourPhones: [...ourPhones],
    phoneLines: phoneLines.slice(0, 6),
  };
}

export function renderHints(h: ThreadHints): string {
  const people = h.outsideParticipants.map(
    (p) => `  - ${p.name ? `${p.name} ` : ""}<${p.email}> (wrote ${p.messages} message(s), mentioned ${p.mentions}x)`,
  );
  return [
    "<hints>",
    "our_people (worked out from who wrote what; never the client):",
    ...(h.ourPeople.length ? h.ourPeople.map((p) => `  - ${p.email}: ${p.why}`) : ["  (none)"]),
    `our_domains: ${h.ourDomains.join(", ")} (and any domain containing "${h.stem}")`,
    "outside_participants (possible client contacts, those who wrote messages first):",
    ...(people.length ? people : ["  (none found)"]),
    `company_guess_from_domain: ${h.companyGuess ?? "(none)"}`,
    `our_phone_numbers (never the client's): ${h.ourPhones.join(", ") || "(none)"}`,
    "other_phone_lines (check labels: M/Mobile = mobile, T/L/Tel = landline):",
    ...(h.phoneLines.length ? h.phoneLines.map((l) => `  - ${l}`) : ["  (none)"]),
    "</hints>",
  ].join("\n");
}
