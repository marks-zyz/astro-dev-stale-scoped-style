// @ts-check
import { defineConfig } from "astro/config";
import { freshAstroStyles } from "./plugins/fresh-astro-styles.mjs";

// Two switches, both off by default, so the same checkout covers every case in the report:
//   ADAPTER=cloudflare   load @astrojs/cloudflare (dev runs through workerd)
//   FRESH_STYLES=1       load the workaround plugin
const useCloudflare = process.env.ADAPTER === "cloudflare";
const useWorkaround = process.env.FRESH_STYLES === "1";

const adapter = useCloudflare
  ? (await import("@astrojs/cloudflare")).default()
  : undefined;

export default defineConfig({
  adapter,
  output: useCloudflare ? "server" : "static",
  vite: {
    plugins: useWorkaround ? [freshAstroStyles()] : [],
  },
});
