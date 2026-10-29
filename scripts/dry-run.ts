// Usage: npm run dry-run -- <gmailMessageId>. Fetches, extracts and validates one mail; no CRM call, no labels, no mail sent.
import { getReference } from "../src/crm.js";
import { getMail } from "../src/gmail.js";
import { draftLead, senderCheck } from "../src/process.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage: npm run dry-run -- <gmailMessageId>");
  process.exit(1);
}

const mail = await getMail(id);
console.log(`From: ${mail.from}\nSubject: ${mail.subject}`);
const rejected = senderCheck(mail);
if (rejected) console.log(`Sender check: would be ignored (${rejected})`);

const result = await draftLead(mail, await getReference());
console.log(JSON.stringify(result, null, 2));
