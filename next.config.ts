import type { NextConfig } from "next";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const config: NextConfig = {
  logging: { incomingRequests: { ignore: [/\/auth\/callback/] } },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node": false,
      sharp: false,
      "@huggingface/transformers": join(
        dirname(require.resolve("@huggingface/transformers")),
        "transformers.web.js",
      ),
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=()" },
          // OAuth popups require an opener. Do not enable COOP same-origin here.
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
        ],
      },
    ];
  },
};
export default config;
