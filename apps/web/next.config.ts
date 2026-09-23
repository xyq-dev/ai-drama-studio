import type { NextConfig } from "next";
import { loadWebPublicEnv } from "./src/lib/public-env";

loadWebPublicEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ai-drama/contracts"],
};

export default nextConfig;
