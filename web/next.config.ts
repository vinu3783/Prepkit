import type { NextConfig } from "next";

/**
 * The browser only ever talks to this origin. /api/* is proxied to the Express
 * API, so the session cookie is first-party (no third-party-cookie problems when
 * the API is deployed on a different host).
 */
const API_URL = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  devIndicators: false,
  experimental: {
    // The dev cache breaks on non-APFS drives (exFAT/FAT external disks), where macOS
    // writes "._*" files that Turbopack cannot parse: "Failed to open database".
    turbopackFileSystemCacheForDev: false,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
