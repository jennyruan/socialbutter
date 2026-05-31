// POST /api/x/connect
//
// One-click "Connect X". Reads the logged-in user's @handle from their X
// session, scrapes the full profile (bio, follower count, avatar, recent
// posts), and pulls a list of recent home-feed authors as a proxy for
// "people you interact with on X" — feeds into the ranker so SocialButter
// knows who you actually engage with.
//
// 401 if not signed in. No body.

import { NextResponse } from "next/server";
import { extractOwnXProfile, SocialSearchError } from "@/lib/social-search";
import { localOnlyGuard } from "@/lib/local-only";

export async function POST() {
  const guard = localOnlyGuard("/api/x/connect");
  if (guard) return guard;

  try {
    const data = await extractOwnXProfile();
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof SocialSearchError) {
      const status = err.cause === "not_logged_in" ? 401 : err.cause === "rate_limited" ? 429 : 502;
      return NextResponse.json(
        { error: err.message, cause: err.cause },
        { status },
      );
    }
    return NextResponse.json(
      { error: `Agent crashed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
