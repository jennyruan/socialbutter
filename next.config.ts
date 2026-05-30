import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep the build fast for hackathon iteration.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
