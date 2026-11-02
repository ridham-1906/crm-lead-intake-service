// Usage: npm run try-examples [-- <gmail-id> ...]. Replays examples/*.txt dumps through cleaning, hints, AI and validation,
// and compares each result with examples/expected.json. Calls the AI; makes no CRM call, sends no mail, applies no labels.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { muteAlerts } from "../src/alert.js";
import { draftLead } from "../src/process.js";
import { parseDump } from "./example-dump.js";

muteAlerts();

type Expected = {
  company?: string;
  email?: string;
  mobile?: string | null;
  budget?: null;
  servicesInclude?: string[];
  servicesExclude?: string[];
};

const dir = join(process.cwd(), "examples");
const expectedFile = join(dir, "expected.json");
const expected: Record<string, Expected> = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, "utf8")) : {};
const only = process.argv.slice(2);
const ids = readdirSync(dir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.replace(/\.txt$/, ""))
  .filter((id) => !only.length || only.includes(id));

let passed = 0;
for (const id of ids) {
  const { mail, reference } = parseDump(id, readFileSync(join(dir, `${id}.txt`), "utf8"));
  let result: Awaited<ReturnType<typeof draftLead>>;
  try {
    result = await draftLead(mail, reference);
  } catch (err) {
    // Every model errored (usually free-tier rate limits): report it and carry on with the next thread.
    console.log(`\nFAIL  ${id}  ${mail.subject}\n      - AI unavailable: ${(err as Error).message}`);
    continue;
  }
  const want = expected[id];
  const problems: string[] = [];

  if (!result.ok) problems.push(`sent to review: ${result.reason}`);
  const lead = result.ok ? result.payload : result.draft;
  if (want && lead) {
    if (want.company && !lead.companyName.toLowerCase().includes(want.company.toLowerCase())) problems.push(`company "${lead.companyName}" ≠ ${want.company}`);
    if (want.email && lead.email !== want.email) problems.push(`email ${lead.email ?? "(none)"} ≠ ${want.email}`);
    if (want.mobile !== undefined && (lead.mobile ?? null) !== want.mobile) problems.push(`mobile ${lead.mobile ?? "(none)"} ≠ ${want.mobile ?? "(none)"}`);
    if (want.budget === null && lead.budget) problems.push(`budget "${lead.budget}" should be empty`);
    for (const s of want.servicesInclude ?? []) if (!lead.services?.includes(s)) problems.push(`missing service ${s}`);
    for (const s of want.servicesExclude ?? []) if (lead.services?.includes(s)) problems.push(`unexpected service ${s}`);
  }

  if (!problems.length) passed++;
  console.log(`\n${problems.length ? "FAIL" : "PASS"}  ${id}  ${mail.subject}`);
  for (const p of problems) console.log(`      - ${p}`);
  console.log(JSON.stringify(lead ?? result, null, 2).replace(/^/gm, "      "));
}
console.log(`\n${passed}/${ids.length} examples passed`);
