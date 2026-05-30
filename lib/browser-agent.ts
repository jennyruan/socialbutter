// ButterSocial backstage browser agent — drives a real Chromium with a
// persistent profile so cookies, fingerprint, and saved sessions match a
// real human. Runs headless by default; output is a result log, not pixels.
//
// Anti-detection layer (best-effort, never bulletproof):
// - Real Chrome channel + persistent profile (no clean-room profile)
// - --disable-blink-features=AutomationControlled
// - navigator.webdriver override
// - Humanized delays, scroll-before-click, char-by-char typing, mouse arcs
// - Conservative per-action rate limits below platform soft-caps
//
// Profile location: ~/.buttersocial-browser-profile (separate from the
// user's daily Chrome so we don't fight for the profile lock). First-time
// setup requires the user to log into Luma + LinkedIn once in that profile.
//
// No mock data (CLAUDE.md §2). If a selector breaks, surface the failure;
// never fake a success.

import { chromium, type BrowserContext, type Page } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE_DIR = join(homedir(), ".buttersocial-browser-profile");

// Conservative limits — well below platform soft-caps to stay invisible.
export const RATE_LIMITS = {
  linkedinConnectsPerHour: 8,    // ~50/week, under LinkedIn's ~100/wk unverified cap
  linkedinConnectsPerDay: 25,
  lumaRsvpsPerHour: 20,
  minDelayBetweenActionsMs: 8_000,
} as const;

export interface BrowserActionResult {
  success: boolean;
  action: string;
  target: string;
  detail?: string;
  startedAt: string;
  finishedAt: string;
}

let sharedContext: BrowserContext | null = null;

/**
 * Open (or reuse) the persistent agent browser. Headless by default for
 * backstage operation; set headless=false to record the agent on camera.
 */
export async function getBrowserContext(options: { headless?: boolean } = {}): Promise<BrowserContext> {
  if (sharedContext) return sharedContext;

  const headless = options.headless ?? true;
  sharedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  // Override the webdriver flag that headless Chromium sets — defeats the
  // cheapest bot detectors. Doesn't defeat real fingerprinting.
  await sharedContext.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  return sharedContext;
}

export async function closeBrowserAgent(): Promise<void> {
  if (sharedContext) {
    await sharedContext.close();
    sharedContext = null;
  }
}

// --- Humanization helpers -------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanWait(min = 600, max = 1800): Promise<void> {
  await new Promise(r => setTimeout(r, randInt(min, max)));
}

async function humanScroll(page: Page, totalPixels = 600): Promise<void> {
  const steps = randInt(3, 6);
  const perStep = Math.floor(totalPixels / steps);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, perStep + randInt(-30, 30));
    await humanWait(180, 420);
  }
}

async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await humanWait(200, 500);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: randInt(45, 140) });
    if (Math.random() < 0.04) await humanWait(300, 900); // occasional pause
  }
}

// --- Actions --------------------------------------------------------------

/**
 * RSVP to a Luma event. Assumes the persistent profile is already logged
 * into Luma. Returns success=false (with detail) if the RSVP button isn't
 * found — caller surfaces that as "needs login" or "event closed".
 */
export async function rsvpLumaEvent(eventUrl: string): Promise<BrowserActionResult> {
  const startedAt = new Date().toISOString();
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(eventUrl, { waitUntil: "domcontentloaded" });
    await humanWait(1_200, 2_400);
    await humanScroll(page, randInt(300, 700));

    // Luma's RSVP button text varies: "Register", "RSVP", "One-Click Register"
    const rsvpButton = page.locator(
      "button:has-text('Register'), button:has-text('RSVP'), button:has-text('One-Click')",
    ).first();

    if (!(await rsvpButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
      return finalize(false, "rsvp_luma", eventUrl, startedAt, "RSVP button not found — may need login or event is closed");
    }

    await rsvpButton.scrollIntoViewIfNeeded();
    await humanWait(400, 1_000);
    await rsvpButton.click();
    await humanWait(2_000, 3_500);

    // If a confirmation modal asks for a name/email, the profile is logged out
    const needsLogin = await page.locator("input[type='email']").isVisible({ timeout: 1_500 }).catch(() => false);
    if (needsLogin) {
      return finalize(false, "rsvp_luma", eventUrl, startedAt, "Profile not logged into Luma — run setup once");
    }

    return finalize(true, "rsvp_luma", eventUrl, startedAt);
  } finally {
    await page.close();
  }
}

/**
 * Send a LinkedIn connect request with an optional note. The caller is
 * responsible for spacing requests via RATE_LIMITS — this function does a
 * single action and returns.
 */
export async function linkedinConnect(profileUrl: string, note?: string): Promise<BrowserActionResult> {
  const startedAt = new Date().toISOString();
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await humanWait(1_500, 3_000);
    await humanScroll(page, randInt(200, 500));

    // The Connect button is either in the top action bar or behind a "More" menu.
    const directConnect = page.locator("button[aria-label*='Invite' i]:has-text('Connect')").first();
    let connectClicked = await directConnect.isVisible({ timeout: 2_500 }).catch(() => false);

    if (connectClicked) {
      await directConnect.click();
    } else {
      const moreButton = page.locator("button[aria-label*='More actions' i]").first();
      if (await moreButton.isVisible({ timeout: 2_500 }).catch(() => false)) {
        await moreButton.click();
        await humanWait(600, 1_200);
        const menuConnect = page.locator("div[role='menu'] :text-matches('Connect', 'i')").first();
        if (await menuConnect.isVisible({ timeout: 2_500 }).catch(() => false)) {
          await menuConnect.click();
          connectClicked = true;
        }
      }
    }

    if (!connectClicked) {
      return finalize(false, "linkedin_connect", profileUrl, startedAt, "Connect button not visible (already connected or restricted profile)");
    }

    await humanWait(900, 1_800);

    if (note && note.trim()) {
      const addNote = page.locator("button:has-text('Add a note'), button:has-text('Add a free note')").first();
      if (await addNote.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await addNote.click();
        await humanWait(500, 1_000);
        await humanType(page, "textarea[name='message']", note.slice(0, 300));
        await humanWait(600, 1_200);
      }
    }

    const sendButton = page.locator("button[aria-label*='Send' i]:not([disabled])").first();
    if (!(await sendButton.isVisible({ timeout: 4_000 }).catch(() => false))) {
      return finalize(false, "linkedin_connect", profileUrl, startedAt, "Send button not enabled — profile may require premium or hit weekly limit");
    }
    await sendButton.click();
    await humanWait(1_500, 2_500);

    return finalize(true, "linkedin_connect", profileUrl, startedAt);
  } finally {
    await page.close();
  }
}

// --- Backstage queue runner -----------------------------------------------

export interface QueuedAction {
  kind: "rsvp_luma" | "linkedin_connect";
  target: string;
  note?: string;
}

/**
 * Run a batch of actions backstage with conservative spacing (8s+ jitter
 * between each). Returns results in execution order; caller can pipe
 * `onProgress` to a live UI counter.
 *
 * Day/hour-level caps live in RATE_LIMITS but aren't enforced here —
 * caller should split batches across windows.
 */
export async function runBackstageQueue(
  actions: QueuedAction[],
  onProgress?: (result: BrowserActionResult, index: number) => void,
): Promise<BrowserActionResult[]> {
  const results: BrowserActionResult[] = [];
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    const res = act.kind === "rsvp_luma"
      ? await rsvpLumaEvent(act.target)
      : await linkedinConnect(act.target, act.note);
    results.push(res);
    onProgress?.(res, i);
    if (i < actions.length - 1) {
      await humanWait(RATE_LIMITS.minDelayBetweenActionsMs, RATE_LIMITS.minDelayBetweenActionsMs + 4_000);
    }
  }
  return results;
}

// --- Internal -------------------------------------------------------------

function finalize(
  success: boolean,
  action: string,
  target: string,
  startedAt: string,
  detail?: string,
): BrowserActionResult {
  return {
    success,
    action,
    target,
    detail,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
