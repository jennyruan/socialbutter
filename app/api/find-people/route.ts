import { NextResponse } from "next/server";
import { findPerson, SocialSearchError, type SocialSource } from "@/lib/social-search";
import { localOnlyGuard } from "@/lib/local-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED: SocialSource[] = ["x", "linkedin"];

export async function POST(req: Request) {
  const guard = localOnlyGuard("/api/find-people");
  if (guard) return guard;

  let body: { source?: string; input?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const source = body.source as SocialSource | undefined;
  const input = body.input?.trim();
  if (!source || !ALLOWED.includes(source)) {
    return NextResponse.json(
      { error: `Missing or invalid 'source' (expected one of: ${ALLOWED.join(", ")})` },
      { status: 400 },
    );
  }
  if (!input) {
    return NextResponse.json({ error: "Missing 'input' (handle or profile URL)" }, { status: 400 });
  }

  try {
    const person = await findPerson(source, input);
    return NextResponse.json({ person, source, input });
  } catch (err) {
    if (err instanceof SocialSearchError) {
      const status = err.cause === "not_logged_in" ? 401 : 502;
      return NextResponse.json(
        { error: err.message, source: err.source, cause: err.cause },
        { status },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
