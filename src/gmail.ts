import { google, type gmail_v1 } from "googleapis";
import { getEnv } from "./env.js";
import { buildRawMail, forwardSubject, parseMessage, type Mail } from "./mail.js";

export const DONE = "CRM-Done";
export const REVIEW = "CRM-Review";
export const IGNORED = "CRM-Ignored";
export const OUTCOME_LABELS = [DONE, REVIEW, IGNORED] as const;
export type OutcomeLabel = (typeof OUTCOME_LABELS)[number];

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

const MAX_ATTACHED_ORIGINAL = 10 * 1024 * 1024;

let client: gmail_v1.Gmail | undefined;
const labelIds = new Map<string, string>();

function gmail(): gmail_v1.Gmail {
  if (client) return client;
  const env = getEnv();
  const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  client = google.gmail({ version: "v1", auth });
  return client;
}

function labelId(name: string): string {
  const id = labelIds.get(name);
  if (!id) throw new Error(`Label ${name} not resolved; call ensureLabels() first`);
  return id;
}

// Fails when the refresh token belongs to a different mailbox than INTAKE_MAILBOX.
export async function assertMailbox(): Promise<void> {
  const expected = getEnv().INTAKE_MAILBOX;
  const { data } = await gmail().users.getProfile({ userId: "me" });
  const actual = data.emailAddress?.toLowerCase();
  if (actual !== expected) {
    throw new Error(`GMAIL_REFRESH_TOKEN is for ${actual ?? "an unknown mailbox"}, but INTAKE_MAILBOX is ${expected}`);
  }
}

// Resolves label ids by name, creating any of ours that are missing.
export async function ensureLabels(): Promise<void> {
  const names = [getEnv().GMAIL_INTAKE_LABEL, ...OUTCOME_LABELS];
  const { data } = await gmail().users.labels.list({ userId: "me" });
  for (const label of data.labels ?? []) {
    if (label.name && label.id) labelIds.set(label.name, label.id);
  }
  for (const name of names) {
    if (labelIds.has(name)) continue;
    const created = await gmail().users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    if (created.data.id) labelIds.set(name, created.data.id);
  }
}

export async function watch(): Promise<string | null | undefined> {
  const env = getEnv();
  const { data } = await gmail().users.watch({
    userId: "me",
    requestBody: {
      topicName: env.GMAIL_PUBSUB_TOPIC,
      labelIds: [labelId(env.GMAIL_INTAKE_LABEL)],
      labelFilterBehavior: "include",
    },
  });
  return data.expiration;
}

export async function searchUnprocessed(): Promise<string[]> {
  // Gmail search spells spaces in label names as hyphens.
  const term = (name: string) => `label:${name.replace(/\s+/g, "-")}`;
  const q = [term(getEnv().GMAIL_INTAKE_LABEL), ...OUTCOME_LABELS.map((l) => `-${term(l)}`)].join(" ");
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await gmail().users.messages.list({ userId: "me", q, pageToken, maxResults: 100 });
    for (const m of data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  // Oldest first, so leads are created in arrival order.
  return ids.reverse();
}

export async function getMail(id: string): Promise<Mail> {
  const { data } = await gmail().users.messages.get({ userId: "me", id, format: "full" });
  return parseMessage(data);
}

export function hasOutcomeLabel(mail: Mail): boolean {
  return OUTCOME_LABELS.some((name) => mail.labelIds.includes(labelId(name)));
}

export async function addLabel(id: string, name: OutcomeLabel): Promise<void> {
  await gmail().users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [labelId(name)] } });
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const raw = buildRawMail({ to, subject, text });
  await gmail().users.messages.send({ userId: "me", requestBody: { raw } });
}

// Forwards the mail as text below the note, with the original attached as an .eml file.
export async function forward(mail: Mail, to: string, note: string): Promise<void> {
  const { data } = await gmail().users.messages.get({ userId: "me", id: mail.id, format: "raw" });
  const original = data.raw ? Buffer.from(data.raw, "base64url") : undefined;
  const attach = original && original.length <= MAX_ATTACHED_ORIGINAL;

  const text = [
    note,
    "",
    "---------- Forwarded message ---------",
    `From: ${mail.fromHeader}`,
    `Date: ${mail.date}`,
    `Subject: ${mail.subject}`,
    `To: ${mail.to.join(", ")}`,
    ...(mail.cc.length ? [`Cc: ${mail.cc.join(", ")}`] : []),
    "",
    mail.body,
  ].join("\n");

  const raw = buildRawMail({
    to,
    subject: forwardSubject(mail.subject),
    text,
    attachment: attach
      ? { filename: "original.eml", contentType: "application/octet-stream", base64: original.toString("base64") }
      : undefined,
  });
  await gmail().users.messages.send({ userId: "me", requestBody: { raw } });
}
