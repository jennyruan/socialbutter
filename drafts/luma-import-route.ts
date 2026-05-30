// API route stub — move to app/api/luma/import/route.ts after scaffold.
//
// Imports events from a Luma username, profile URL, or event URL.
// Returns normalized LumaEvent[] for the client.

import { NextResponse } from "next/server";
import { fetchLumaFromInput, LumaFetchError } from "@/lib/luma";

export async function POST(req: Request) {
  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "Missing 'input'" }, { status: 400 });
  }

  try {
    const events = await fetchLumaFromInput(input);
    return NextResponse.json({ events, count: events.length });
  } catch (err) {
    if (err instanceof LumaFetchError) {
      return NextResponse.json(
        { error: err.message, url: err.url, status: err.status },
        { status: err.status ?? 502 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
