import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@zeus/publisher-contracts"],
};

export default nextConfig;
