import type { NextConfig } from "next";

// GitHub Pages: a static export served under /<repo>. The API routes are
// removed before this build (see .github/workflows/pages.yml).
const pages = process.env.NEXT_PUBLIC_STATIC === "1";
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  ...(pages ? { output: "export" as const, basePath, trailingSlash: true, images: { unoptimized: true } } : {}),
  // Partial prerendering cannot run in a static export.
  ...(pages ? {} : { cacheComponents: true, partialPrefetching: true }),
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
