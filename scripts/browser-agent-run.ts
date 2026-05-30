#!/usr/bin/env node
// CLI runner for the backstage browser agent. Single actions for testing,
// queue mode for batch demos.
//
// Usage:
//   pnpm exec tsx scripts/browser-agent-run.ts rsvp <eventUrl>
//   pnpm exec tsx scripts/browser-agent-run.ts connect <profileUrl> ["optional note"]
//   pnpm exec tsx scripts/browser-agent-run.ts queue <pathToJson>
//
// queue JSON shape:
//   [{ "kind": "rsvp_luma", "target": "https://lu.ma/xyz" },
//    { "kind": "linkedin_connect", "target": "https://www.linkedin.com/in/...", "note": "..." }]
//
// HEADLESS=0 to show the browser on screen.

import { readFileSync } from "node:fs";
import {
  getBrowserContext,
  closeBrowserAgent,
  rsvpLumaEvent,
  linkedinConnect,
  runBackstageQueue,
  type QueuedAction,
} from "../lib/browser-agent";

async function main() {
  const [, , cmd, arg1, arg2] = process.argv;
  if (!cmd) {
    console.error("Usage: browser-agent-run.ts <rsvp|connect|queue> <args...>");
    process.exit(1);
  }

  const headless = process.env.HEADLESS !== "0";
  await getBrowserContext({ headless });

  let result: unknown;
  if (cmd === "rsvp") {
    result = await rsvpLumaEvent(arg1);
  } else if (cmd === "connect") {
    result = await linkedinConnect(arg1, arg2);
  } else if (cmd === "queue") {
    const queue = JSON.parse(readFileSync(arg1, "utf8")) as QueuedAction[];
    result = await runBackstageQueue(queue, (r, i) => {
      console.log(
        `[${i + 1}/${queue.length}] ${r.success ? "✓" : "✗"} ${r.action} ${r.target}${r.detail ? ` — ${r.detail}` : ""}`,
      );
    });
  } else {
    console.error("Unknown command:", cmd);
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
  await closeBrowserAgent();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
