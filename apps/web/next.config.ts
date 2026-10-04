import type { NextConfig } from "next";
import { resolveApiUpstream } from "./src/lib/api-upstream";
import { loadWebPublicEnv } from "./src/lib/public-env";

loadWebPublicEnv();

const apiOrigin = resolveApiUpstream(process.env.NEXT_PUBLIC_API_BASE_URL);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ai-drama/contracts", "@ai-drama/domain"],
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiOrigin}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
