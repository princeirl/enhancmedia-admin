import type { NextConfig } from "next";

// Static export: the admin interface is prebuilt to `out/` and served by the Worker in
// `worker/`, which also answers /api/. Nothing renders on a server.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
