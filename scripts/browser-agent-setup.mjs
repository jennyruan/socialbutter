#!/usr/bin/env node
// One-time setup: launches the ButterSocial agent profile with a visible
// browser so the user can log into Luma + LinkedIn. After they sign in
// and close the window, the persistent profile keeps the cookies and the
// headless agent reuses them forever (until tokens expire).
//
// Usage:
//   node scripts/browser-agent-setup.mjs
//
// Walks the user through:
//   1. Open Luma → sign in
//   2. Open LinkedIn → sign in
//   3. Close window → done

import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".buttersocial-browser-profile");

console.log("ButterSocial agent setup");
console.log("Profile directory:", PROFILE_DIR);
console.log("");
console.log("Steps:");
console.log("  1. A Chrome window will open.");
console.log("  2. Sign into https://lu.ma");
console.log("  3. Sign into https://linkedin.com");
console.log("  4. Close the window when done.");
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

console.log("Sign in on both tabs, then close the window.");

await ctx.waitForEvent("close").catch(() => {});
console.log("Setup complete — cookies saved to profile.");
process.exit(0);
