import { NextResponse } from "next/server";

// Returns a 501 response when running on Vercel (or any env where
// IS_SERVERLESS is set), otherwise null. Playwright-driven routes use this
// to fail loud + fast in production instead of dynamically requiring a
// package that isn't installed there.
export function localOnlyGuard(routeName: string): NextResponse | null {
  if (process.env.VERCEL || process.env.IS_SERVERLESS) {
    return NextResponse.json(
      {
        error: `${routeName} requires the local backstage browser agent`,
        local_only: true,
        hint: "Run the app locally (pnpm dev) with the persistent Chrome profile signed in via scripts/browser-agent-setup.mjs.",
      },
      { status: 501 },
    );
  }
  return null;
}
