import { NextResponse } from "next/server";
import {
  draftHostIntro,
  draftPersonIntro,
  type RankableEvent,
  type RankablePerson,
} from "@/lib/agent";
import { getEvermind } from "@/lib/evermind";
import { getLLM } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  let body: { person?: RankablePerson; event?: RankableEvent; goal?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Two paths:
  //   person provided → draftPersonIntro (DM to that person, optional event context)
  //   only event provided → draftHostIntro (DM to event host)
  try {
    const deps = { evermind: getEvermind(), llm: getLLM() };
    if (body.person?.name) {
      const draft = await draftPersonIntro(
        body.person,
        { event: body.event, goal: body.goal },
        deps,
      );
      return NextResponse.json({ draft, mode: "person" });
    }
    if (body.event?.title) {
      const draft = await draftHostIntro(body.event, deps);
      return NextResponse.json({ draft, mode: "event-host" });
    }
    return NextResponse.json(
      { error: "Provide either 'person' or 'event' (or both — person takes precedence)." },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
