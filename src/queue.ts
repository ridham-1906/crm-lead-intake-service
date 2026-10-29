import { alert, type Stage } from "./alert.js";
import { CrmUnavailableError } from "./crm.js";
import { getEnv } from "./env.js";
import { AiUnavailableError } from "./ai.js";
import { searchUnprocessed } from "./gmail.js";
import { errInfo, log } from "./log.js";
import { processMessage } from "./process.js";

// FIFO of Gmail message ids; `known` holds everything queued or in progress so nothing is queued twice.
const pending: string[] = [];
const known = new Set<string>();
let draining = false;
let sweeping = false;
let sweepAgain = false;
// Dry runs apply no labels, so remember what was already processed in this process.
const dryRunSeen = new Set<string>();

export function queueStatus(): { pending: number; draining: boolean } {
  return { pending: pending.length, draining };
}

export function enqueue(ids: string[]): void {
  const dryRun = getEnv().DRY_RUN;
  let added = 0;
  for (const id of ids) {
    if (known.has(id) || (dryRun && dryRunSeen.has(id))) continue;
    known.add(id);
    pending.push(id);
    added++;
  }
  if (added) log.info({ added, pending: pending.length }, "mail queued");
  void drain();
}

function stageOf(err: unknown): Stage {
  if (err instanceof AiUnavailableError) return "AI";
  if (err instanceof CrmUnavailableError) return "CRM";
  if ((err as { config?: unknown })?.config) return "Gmail";
  return "Processing";
}

// Single worker: one mail at a time, in arrival order.
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    let id: string | undefined;
    while ((id = pending.shift())) {
      try {
        const outcome = await processMessage(id);
        if (getEnv().DRY_RUN) dryRunSeen.add(id);
        log.debug({ messageId: id, outcome }, "message processed");
      } catch (err) {
        // Left unlabelled, so the next sweep queues it again.
        log.error({ err: errInfo(err), messageId: id }, "processing failed; will retry");
        await alert({ stage: stageOf(err), summary: "a mail could not be processed", error: err, messageId: id });
      } finally {
        known.delete(id);
      }
    }
  } finally {
    draining = false;
  }
}

// Searches Gmail for unprocessed mail and queues it; overlapping triggers collapse into one extra search.
export async function sweep(trigger: string): Promise<void> {
  if (sweeping) {
    sweepAgain = true;
    return;
  }
  sweeping = true;
  try {
    do {
      sweepAgain = false;
      try {
        enqueue(await searchUnprocessed());
      } catch (err) {
        log.error({ err: errInfo(err), trigger }, "gmail search failed");
        await alert({ stage: "Gmail", summary: "searching the mailbox failed", error: err, extra: { trigger } });
      }
    } while (sweepAgain);
  } finally {
    sweeping = false;
  }
}
