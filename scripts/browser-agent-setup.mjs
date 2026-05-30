#!/usr/bin/env node
// One-time setup: launches the SocialButter agent profile with a visible
// browser so the user can log into Luma + LinkedIn + X. After they sign in
// and close the window, the persistent profile keeps the cookies and the
// headless agent reuses them forever (until tokens expire).
//
// Usage:
//   node scripts/browser-agent-setup.mjs
//
// Walks the user through:
//   1. Open Luma → sign in
//   2. Open LinkedIn → sign in
//   3. Open X (twitter) → sign in
//   4. Close window → done

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".socialbutter-browser-profile");

console.log("SocialButter agent setup");
console.log("Profile directory:", PROFILE_DIR);
console.log("");
console.log("Steps:");
console.log("  1. A Chrome window will open with three tabs.");
console.log("  2. Sign into https://lu.ma");
console.log("  3. Sign into https://linkedin.com");
console.log("  4. Sign into https://x.com");
console.log("  5. Close the window when done.");
console.log("");

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: { width: 1280, height: 800 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://lu.ma");

const linkedinPage = await ctx.newPage();
await linkedinPage.goto("https://www.linkedin.com");

const xPage = await ctx.newPage();
await xPage.goto("https://x.com/login");

console.log("Sign in on all three tabs, then close the window.");

await ctx.waitForEvent("close").catch(() => {});
console.log("Setup complete — cookies saved to profile.");
process.exit(0);
