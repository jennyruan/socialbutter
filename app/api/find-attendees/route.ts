import { NextResponse } from "next/server";
import { findLumaEventAttendees, SocialSearchError } from "@/lib/social-search";
import { rankPeople, type RankableEvent, type RankablePerson } from "@/lib/agent";
import { getEvermind } from "@/lib/evermind";
import { getLLM } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: {
    eventUrl?: string;
    limit?: number;
    rank?: boolean;
    eventContext?: RankableEvent;
    goal?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventUrl = body.eventUrl?.trim();
  if (!eventUrl) {
    return NextResponse.json({ error: "Missing 'eventUrl'" }, { status: 400 });
  }

  try {
    const attendees = await findLumaEventAttendees(eventUrl, { limit: body.limit ?? 24 });

    // Optionally rank via Evermind (which attendees should the user meet)
    if (body.rank && attendees.length > 0) {
      const ranked = await rankPeople(
        attendees as RankablePerson[],
        { evermind: getEvermind(), llm: getLLM() },
        { eventContext: body.eventContext, goal: body.goal },
      );
      return NextResponse.json({
        attendees,
        ranked,
        count: attendees.length,
        ranked_count: ranked.length,
      });
    }

    return NextResponse.json({ attendees, count: attendees.length });
  } catch (err) {
    if (err instanceof SocialSearchError) {
      const status = err.cause === "not_logged_in" ? 401 : 502;
      return NextResponse.json(
        { error: err.message, cause: err.cause },
        { status },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
