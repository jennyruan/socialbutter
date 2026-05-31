import type { NextConfig } from "next";

const config: NextConfig = {
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Playwright is local-dev only (browser-agent routes). Keep it as an
  // external require so webpack doesn't try to bundle chromium binaries
  // into serverless functions on Vercel.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default config;
