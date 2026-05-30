import { NextResponse } from "next/server";
import { rankEvents, type RankableEvent } from "@/lib/agent";
import { getEvermind } from "@/lib/evermind";
import { getLLM } from "@/lib/llm";
import type { CalendarEvent } from "@/lib/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { events?: RankableEvent[]; goal?: string; busyEvents?: CalendarEvent[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return NextResponse.json({ error: "Missing or empty 'events' array" }, { status: 400 });
  }

  try {
    const ranked = await rankEvents(
      events,
      { evermind: getEvermind(), llm: getLLM() },
      { goal: body.goal, busyEvents: body.busyEvents },
    );
    return NextResponse.json({ ranked, count: ranked.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
