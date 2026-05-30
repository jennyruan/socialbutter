// SocialButter — search the social web for events + people info.
//
// Builds on lib/browser-agent.ts (persistent Chromium profile, anti-detection)
// to scrape REAL data from X and LinkedIn. Both require the agent profile
// to be logged in once via `scripts/browser-agent-setup.mjs`.
//
// No mocks (CLAUDE.md §2): if a selector breaks or the profile isn't
// logged in, we surface a clear error — never fabricate results.

import type { Page } from "playwright";
import { getBrowserContext } from "./browser-agent";

// --- Shared types ---------------------------------------------------------

export type SocialSource = "x" | "linkedin";

export interface DiscoveredEvent {
  source: SocialSource | "luma";
  url: string;
  title: string;
  host?: string;
  datetime?: string;        // ISO if parseable, else original text
  location?: string;
  description?: string;
  attendeeCount?: number;
  raw?: Record<string, unknown>;
}

export interface DiscoveredPerson {
  source: SocialSource;
  handle: string;             // @handle on X, slug on LinkedIn
  url: string;
  name: string;
  headline?: string;
  bio?: string;
  location?: string;
  followers?: number;
  recentPosts?: Array<{ text: string; postedAt?: string; url?: string }>;
  avatarUrl?: string;
  raw?: Record<string, unknown>;
}

export class SocialSearchError extends Error {
  constructor(
    message: string,
    public readonly source: SocialSource,
    public readonly cause?: "not_logged_in" | "rate_limited" | "selector_broken" | "network",
  ) {
    super(message);
    this.name = "SocialSearchError";
  }
}

// --- Public entrypoints ---------------------------------------------------

export async function findEvents(
  source: SocialSource,
  query: string,
  opts: { limit?: number } = {},
): Promise<DiscoveredEvent[]> {
  if (source === "x") return findEventsOnX(query, opts);
  return findEventsOnLinkedIn(query, opts);
}

export async function findPerson(
  source: SocialSource,
  input: string,
): Promise<DiscoveredPerson> {
  if (source === "x") return findPersonOnX(input);
  return findPersonOnLinkedIn(input);
}

// --- X (Twitter) ----------------------------------------------------------

export async function findEventsOnX(
  query: string,
  opts: { limit?: number } = {},
): Promise<DiscoveredEvent[]> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    // X's live-search surfaces recent posts about events better than the top tab
    const searchQuery = `${query} (event OR meetup OR happy hour OR hackathon OR mixer) -is:retweet`;
    const url = `https://x.com/search?q=${encodeURIComponent(searchQuery)}&f=live`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    if (await isXLoggedOut(page)) {
      throw new SocialSearchError(
        "X profile is not logged in. Run `node scripts/browser-agent-setup.mjs` and sign into X in the profile window.",
        "x",
        "not_logged_in",
      );
    }

    // Wait for the timeline to render. The timeline is `[data-testid=primaryColumn]`.
    await page.waitForSelector("[data-testid='primaryColumn']", { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Scroll a bit to load more results
    await page.mouse.wheel(0, 1_200);
    await page.waitForTimeout(800);

    const events = await page.evaluate((limit) => {
      const cards = Array.from(
        document.querySelectorAll("[data-testid='cellInnerDiv']"),
      ).slice(0, limit);

      return cards.flatMap((cell) => {
        const article = cell.querySelector("article");
        if (!article) return [];

        const textBlock = article.querySelector("[data-testid='tweetText']");
        const text = textBlock?.textContent?.trim() ?? "";
        if (!text) return [];

        const authorLink = article.querySelector("a[role='link'][href^='/']");
        const authorHandle = authorLink?.getAttribute("href")?.replace(/^\//, "") ?? "";

        const timeEl = article.querySelector("time");
        const datetime = timeEl?.getAttribute("datetime") ?? undefined;

        const linkEl = article.querySelector("a[href*='/status/']");
        const tweetPath = linkEl?.getAttribute("href") ?? "";
        const url = tweetPath ? `https://x.com${tweetPath}` : "";

        // Try to spot a Luma / Eventbrite link in the tweet
        const lumaAnchor = article.querySelector("a[href*='lu.ma'], a[href*='luma.com'], a[href*='eventbrite.com']");
        const eventUrl = lumaAnchor?.getAttribute("href") ?? url;

        return [{
          url: eventUrl,
          title: text.split("\n")[0].slice(0, 160),
          host: authorHandle,
          datetime,
          description: text,
        }];
      });
    }, opts.limit ?? 12);

    return events.map(e => ({ source: "x" as const, ...e }));
  } catch (err) {
    if (err instanceof SocialSearchError) throw err;
    throw new SocialSearchError(
      `X event search failed: ${(err as Error).message}`,
      "x",
      "selector_broken",
    );
  } finally {
    await page.close();
  }
}

export async function findPersonOnX(input: string): Promise<DiscoveredPerson> {
  const handle = normalizeXHandle(input);
  const url = `https://x.com/${handle}`;

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    if (await isXLoggedOut(page)) {
      throw new SocialSearchError(
        "X profile is not logged in. Run `node scripts/browser-agent-setup.mjs`.",
        "x",
        "not_logged_in",
      );
    }

    await page.waitForSelector("[data-testid='primaryColumn']", { timeout: 10_000 });
    await page.waitForTimeout(700);

    const data = await page.evaluate(() => {
      const text = (sel: string) =>
        (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim();

      const nameEl = document.querySelector("[data-testid='UserName']");
      const name = nameEl?.textContent?.split("@")[0]?.trim() ?? "";

      const bio = text("[data-testid='UserDescription']");
      const location = text("[data-testid='UserLocation']");

      const followLinks = Array.from(
        document.querySelectorAll("a[href$='/verified_followers'], a[href$='/followers']"),
      );
      const followersText = followLinks[0]?.textContent ?? "";
      const followersMatch = followersText.match(/([\d.,]+)\s*(K|M)?\s*Followers/i);
      const followers = followersMatch
        ? parseAbbreviated(followersMatch[1], followersMatch[2])
        : undefined;

      const avatarImg = document.querySelector(
        "a[href$='/photo'] img, img[alt^='Opens profile photo']",
      ) as HTMLImageElement | null;
      const avatarUrl = avatarImg?.src;

      const tweetEls = Array.from(
        document.querySelectorAll("article [data-testid='tweetText']"),
      ).slice(0, 5);
      const recentPosts = tweetEls.map((t) => {
        const article = t.closest("article");
        const time = article?.querySelector("time");
        const link = article?.querySelector("a[href*='/status/']") as HTMLAnchorElement | null;
        return {
          text: (t as HTMLElement).innerText.trim(),
          postedAt: time?.getAttribute("datetime") ?? undefined,
          url: link?.href,
        };
      });

      return { name, bio, location, followers, avatarUrl, recentPosts };
    });

    function parseAbbreviated(num: string, suffix?: string): number {
      const n = parseFloat(num.replace(/,/g, ""));
      if (suffix === "K") return Math.round(n * 1_000);
      if (suffix === "M") return Math.round(n * 1_000_000);
      return Math.round(n);
    }

    return {
      source: "x",
      handle,
      url,
      name: data.name || handle,
      bio: data.bio,
      location: data.location,
      followers: data.followers,
      avatarUrl: data.avatarUrl,
      recentPosts: data.recentPosts,
    };
  } catch (err) {
    if (err instanceof SocialSearchError) throw err;
    throw new SocialSearchError(
      `X person lookup failed: ${(err as Error).message}`,
      "x",
      "selector_broken",
    );
  } finally {
    await page.close();
  }
}

// --- LinkedIn -------------------------------------------------------------

export async function findEventsOnLinkedIn(
  query: string,
  opts: { limit?: number } = {},
): Promise<DiscoveredEvent[]> {
  const url = `https://www.linkedin.com/search/results/events/?keywords=${encodeURIComponent(query)}`;

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    if (await isLinkedInLoggedOut(page)) {
      throw new SocialSearchError(
        "LinkedIn profile is not logged in. Run `node scripts/browser-agent-setup.mjs` and sign into LinkedIn in the profile window.",
        "linkedin",
        "not_logged_in",
      );
    }

    // LinkedIn search results sit in `.search-results-container` or similar.
    // Selector landscape is volatile — we query several candidates.
    await page.waitForSelector(
      ".search-results-container, [data-test-search-results-list], main",
      { timeout: 12_000 },
    );
    await page.waitForTimeout(900);
    await page.mouse.wheel(0, 1_400);
    await page.waitForTimeout(700);

    const events = await page.evaluate((limit) => {
      // Event result cards have an event detail anchor with /events/<id>/
      const anchors = Array.from(
        document.querySelectorAll("a[href*='/events/']"),
      ) as HTMLAnchorElement[];

      const seen = new Set<string>();
      const out: Array<Record<string, unknown>> = [];

      for (const a of anchors) {
        const href = a.href.split("?")[0];
        if (!/\/events\/\d+/.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        const card = a.closest("li, div[data-chameleon-result-urn], .reusable-search__result-container") as HTMLElement | null;
        const title = a.innerText?.trim() || card?.querySelector("h3, .entity-result__title-text")?.textContent?.trim() || "Untitled event";

        const meta = card?.innerText ?? "";
        const dateMatch = meta.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+[A-Z][a-z]+\s+\d{1,2}[^\n]*/);
        const hostMatch = meta.match(/(?:Host|Organizer)[:\s]+([^\n]+)/i);

        out.push({
          url: href,
          title,
          host: hostMatch?.[1]?.trim(),
          datetime: dateMatch?.[0]?.trim(),
          description: meta.split("\n").slice(0, 6).join(" • ").slice(0, 280),
        });
        if (out.length >= limit) break;
      }
      return out;
    }, opts.limit ?? 12);

    return events.map(e => ({ source: "linkedin" as const, ...e } as DiscoveredEvent));
  } catch (err) {
    if (err instanceof SocialSearchError) throw err;
    throw new SocialSearchError(
      `LinkedIn event search failed: ${(err as Error).message}`,
      "linkedin",
      "selector_broken",
    );
  } finally {
    await page.close();
  }
}

export async function findPersonOnLinkedIn(input: string): Promise<DiscoveredPerson> {
  const slug = normalizeLinkedInSlug(input);
  const url = `https://www.linkedin.com/in/${slug}/`;

  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    if (await isLinkedInLoggedOut(page)) {
      throw new SocialSearchError(
        "LinkedIn profile is not logged in. Run `node scripts/browser-agent-setup.mjs`.",
        "linkedin",
        "not_logged_in",
      );
    }

    await page.waitForSelector("main", { timeout: 12_000 });
    await page.waitForTimeout(800);

    const data = await page.evaluate(() => {
      const text = (sel: string) =>
        (document.querySelector(sel) as HTMLElement | null)?.innerText?.trim();

      const name = text("h1") ?? "";
      const headline = text(".text-body-medium.break-words") ?? text("[data-generated-suggestion-target]");
      const location = text(".text-body-small.inline.t-black--light.break-words")
        ?? text("span.text-body-small.inline.t-black--light");

      const aboutEl = document.querySelector("section:has(#about) .display-flex.full-width span[aria-hidden='true']")
        ?? document.querySelector("section:has(div[id='about']) .display-flex span[aria-hidden='true']");
      const bio = (aboutEl as HTMLElement | null)?.innerText?.trim();

      const followersEl = Array.from(document.querySelectorAll("p, span"))
        .find(el => /\bfollowers\b/i.test(el.textContent ?? "")) as HTMLElement | null;
      const followersMatch = followersEl?.textContent?.match(/([\d,]+)\s*followers/i);
      const followers = followersMatch ? parseInt(followersMatch[1].replace(/,/g, ""), 10) : undefined;

      const avatarImg = document.querySelector(
        "img.pv-top-card-profile-picture__image, img[alt*='profile photo' i]",
      ) as HTMLImageElement | null;

      return {
        name,
        headline,
        location,
        bio,
        followers,
        avatarUrl: avatarImg?.src,
      };
    });

    return {
      source: "linkedin",
      handle: slug,
      url,
      name: data.name || slug,
      headline: data.headline,
      location: data.location,
      bio: data.bio,
      followers: data.followers,
      avatarUrl: data.avatarUrl,
    };
  } catch (err) {
    if (err instanceof SocialSearchError) throw err;
    throw new SocialSearchError(
      `LinkedIn person lookup failed: ${(err as Error).message}`,
      "linkedin",
      "selector_broken",
    );
  } finally {
    await page.close();
  }
}

// --- Luma attendees (guest list) ------------------------------------------

/**
 * Scrape the guest list off a public Luma event page.
 *
 * Loads the page in the persistent browser, expands the guest list panel
 * if present, and pulls names + avatar URLs. Returns DiscoveredPerson[]
 * with source="x" placeholder (Luma isn't a SocialSource — the agent
 * downstream treats these as ranking inputs by name + headline).
 *
 * Throws if the event has no public guest list (Luma allows hosts to hide it).
 */
export async function findLumaEventAttendees(
  eventUrl: string,
  opts: { limit?: number } = {},
): Promise<DiscoveredPerson[]> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(900);

    // The guest list panel typically has a "See all" button when there are >N guests.
    const seeAll = page.locator(
      "button:has-text('See all'), button:has-text('See guests'), a:has-text('See all')",
    ).first();
    if (await seeAll.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await seeAll.click().catch(() => {});
      await page.waitForTimeout(900);
    }

    // Scroll to load more
    await page.mouse.wheel(0, 1_400);
    await page.waitForTimeout(500);

    const guests = await page.evaluate((limit) => {
      // Luma uses links to /user/<slug> for guests; capture them with their avatar + alt text
      const anchors = Array.from(
        document.querySelectorAll(
          "a[href*='/user/'], a[href^='/u/']",
        ),
      ) as HTMLAnchorElement[];

      const seen = new Set<string>();
      const out: Array<Record<string, unknown>> = [];

      for (const a of anchors) {
        const href = a.href.split("?")[0];
        if (!/\/(user|u)\//.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);

        const slug = href.split("/").filter(Boolean).pop() ?? "";
        const img = a.querySelector("img") as HTMLImageElement | null;
        // Name candidates: alt text on avatar, then anchor text, then slug
        const name =
          (img?.alt && img.alt.trim()) ||
          (a.innerText && a.innerText.trim()) ||
          slug;

        out.push({
          handle: slug,
          url: href,
          name: name.replace(/\s+/g, " ").slice(0, 80),
          avatarUrl: img?.src,
        });
        if (out.length >= limit) break;
      }
      return out;
    }, opts.limit ?? 24);

    if (guests.length === 0) {
      throw new SocialSearchError(
        "No public guest list found on this Luma event (host may have it hidden).",
        "x", // placeholder — Luma isn't a SocialSource literal
        "selector_broken",
      );
    }

    return guests.map((g) => ({
      source: "x" as const, // placeholder; consumers should look at handle/url
      handle: String(g.handle ?? ""),
      url: String(g.url ?? ""),
      name: String(g.name ?? ""),
      avatarUrl: g.avatarUrl as string | undefined,
    }));
  } catch (err) {
    if (err instanceof SocialSearchError) throw err;
    throw new SocialSearchError(
      `Luma attendee scrape failed: ${(err as Error).message}`,
      "x",
      "selector_broken",
    );
  } finally {
    await page.close();
  }
}

// --- Helpers --------------------------------------------------------------

function normalizeXHandle(input: string): string {
  const trimmed = input.trim().replace(/^@/, "");
  try {
    const u = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (u.hostname === "x.com" || u.hostname === "twitter.com" || u.hostname === "www.twitter.com") {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) return seg;
    }
  } catch {
    // not a URL
  }
  return trimmed;
}

function normalizeLinkedInSlug(input: string): string {
  const trimmed = input.trim();
  try {
    const u = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (u.hostname.endsWith("linkedin.com")) {
      const m = u.pathname.match(/\/in\/([^/]+)/);
      if (m) return m[1];
    }
  } catch {
    // not a URL
  }
  return trimmed.replace(/^\/?(in\/)?/, "").replace(/\/$/, "");
}

/**
 * Read the logged-in user's own X handle, then run a full profile scrape.
 * One-click "Connect X" — gives SocialButter your @handle, bio, follower
 * count, avatar, and recent posts so the ranker can prime on who you
 * actually are on X (not guessing from Evermind alone).
 */
export interface OwnXProfile {
  source: "x";
  handle: string;
  profile: DiscoveredPerson;
  recentInteractions: Array<{ handle: string; via: "reply" | "like" | "rt" | "feed"; lastSeenAt?: string }>;
}

export async function extractOwnXProfile(): Promise<OwnXProfile> {
  const ctx = await getBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });

    // Catch login redirects (X uses several URL shapes for the auth wall)
    const url = page.url();
    if (url.includes("/i/flow/login") || url.includes("/login") || url.includes("/signin") || url.includes("/i/flow/signup")) {
      throw new SocialSearchError(
        `X is not logged in (redirected to ${url}). Run \`node scripts/browser-agent-setup.mjs\` and sign into X.`,
        "x",
        "not_logged_in",
      );
    }
    if (await isXLoggedOut(page)) {
      throw new SocialSearchError(
        "X is not logged in. Run `node scripts/browser-agent-setup.mjs` and sign in.",
        "x",
        "not_logged_in",
      );
    }

    // Wait for ANY of the logged-in layout markers (X has rolled the DOM a few times)
    const ready = await Promise.race([
      page.waitForSelector("[data-testid='primaryColumn']", { timeout: 20_000 }).then(() => "primaryColumn").catch(() => null),
      page.waitForSelector("a[data-testid='AppTabBar_Profile_Link']", { timeout: 20_000 }).then(() => "profileLink").catch(() => null),
      page.waitForSelector("main[role='main']", { timeout: 20_000 }).then(() => "mainRole").catch(() => null),
    ]);
    if (!ready) {
      throw new SocialSearchError(
        `X home feed didn't render in 20s (URL: ${page.url()}). Could be an interstitial (verify-it's-you, age gate, rate limit). Try opening x.com in the agent browser via setup script.`,
        "x",
        "selector_broken",
      );
    }
    await page.waitForTimeout(800);

    // Find own handle from the profile nav link (href is /<handle>)
    const handle = await page.evaluate(() => {
      const link = document.querySelector(
        "a[data-testid='AppTabBar_Profile_Link']",
      ) as HTMLAnchorElement | null;
      if (link?.pathname) return link.pathname.replace(/^\/+/, "").toLowerCase();
      const acct = document.querySelector("[data-testid='SideNav_AccountSwitcher_Button']");
      const text = acct?.textContent ?? "";
      const m = text.match(/@(\w+)/);
      return m ? m[1].toLowerCase() : "";
    });
    if (!handle) {
      throw new SocialSearchError(
        "Couldn't read own X handle from sidebar — DOM may have changed.",
        "x",
        "selector_broken",
      );
    }

    // Scrape the home feed authors as "recent interactions" before navigating away
    const feedAuthors = await page.evaluate(() => {
      const tweets = Array.from(document.querySelectorAll("article")).slice(0, 25);
      const seen = new Map<string, { lastSeenAt?: string }>();
      for (const t of tweets) {
        const link = t.querySelector("[data-testid='User-Name'] a[href^='/']") as HTMLAnchorElement | null;
        const h = link?.pathname?.replace(/^\/+/, "")?.toLowerCase();
        if (!h || h.includes("/")) continue;
        const time = t.querySelector("time")?.getAttribute("datetime") ?? undefined;
        if (!seen.has(h)) seen.set(h, { lastSeenAt: time });
      }
      return Array.from(seen.entries()).map(([handle, { lastSeenAt }]) => ({ handle, lastSeenAt }));
    });

    await page.close();

    const profile = await findPersonOnX(handle);

    const recentInteractions = feedAuthors
      .filter((a) => a.handle !== handle)
      .slice(0, 15)
      .map((a) => ({ handle: a.handle, via: "feed" as const, lastSeenAt: a.lastSeenAt }));

    return { source: "x", handle, profile, recentInteractions };
  } catch (err) {
    await page.close().catch(() => {});
    if (err instanceof SocialSearchError) throw err;
    throw new SocialSearchError(
      `Own X profile extract failed: ${(err as Error).message}`,
      "x",
      "selector_broken",
    );
  }
}

async function isXLoggedOut(page: Page): Promise<boolean> {
  // X redirects logged-out users to a login splash or shows a sign-in modal.
  const loginCta = page.locator("a[href='/login'], [data-testid='loginButton']").first();
  return await loginCta.isVisible({ timeout: 1_500 }).catch(() => false);
}

async function isLinkedInLoggedOut(page: Page): Promise<boolean> {
  // LinkedIn shows the auth wall under linkedin.com/uas/login or shows a "Sign in" button.
  if (page.url().includes("/uas/login") || page.url().includes("/login")) return true;
  const signIn = page.locator("a[data-tracking-control-name='guest_homepage-basic_nav-header-signin'], a:has-text('Sign in')").first();
  return await signIn.isVisible({ timeout: 1_500 }).catch(() => false);
}
