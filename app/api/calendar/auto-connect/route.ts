// POST /api/calendar/auto-connect
//
// Body: { source: "luma" | "google" | "apple", calendarName?: string }
//
// Drives the backstage browser agent (persistent profile) to extract the
// user's calendar subscription URL for the given source, then immediately
// pipes that URL through the calendar import flow so events come back in
// one round-trip.
//
// On not-signed-in / not-shared: returns 401 with a clear next-step hint.

import { NextResponse } from "next/server";
import {
  extractLumaSubscriptionUrl,
  extractGoogleCalendarSubscriptionUrl,
  extractAppleCalendarSubscriptionUrl,
  type SubscriptionExtractResult,
} from "@/lib/browser-agent";
import { fetchCalendarFromUrl } from "@/lib/calendar";

type Source = "luma" | "google" | "apple";

export async function POST(req: Request) {
  let body: { source?: Source; calendarName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const source = body.source;
  if (source !== "luma" && source !== "google" && source !== "apple") {
    return NextResponse.json({ error: "source must be 'luma' | 'google' | 'apple'" }, { status: 400 });
  }

  let extract: SubscriptionExtractResult;
  try {
    if (source === "luma") {
      extract = await extractLumaSubscriptionUrl();
    } else if (source === "google") {
      extract = await extractGoogleCalendarSubscriptionUrl(body.calendarName);
    } else {
      extract = await extractAppleCalendarSubscriptionUrl(body.calendarName);
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Agent crashed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  if (!extract.success || !extract.url) {
    const status = extract.detail?.toLowerCase().includes("not signed") ? 401 : 422;
    return NextResponse.json(
      {
        error: extract.detail ?? "Failed to extract subscription URL",
        source,
        action: extract.action,
      },
      { status },
    );
  }

  // Pipe the URL straight into the calendar import flow
  try {
    const events = await fetchCalendarFromUrl(extract.url);
    return NextResponse.json({
      source,
      url: extract.url,
      events,
      count: events.length,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Got URL but couldn't import events: ${(err as Error).message}`,
        source,
        url: extract.url,
      },
      { status: 502 },
    );
  }
}
