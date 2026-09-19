// Dev-only Vite plugin. On every saved .astro file it re-transforms the file in the SSR
// environment BEFORE Vite tells the browser about the update, so the in-memory compile
// metadata that serves `X.astro?astro&type=style&index=N&lang.css` is already current when
// the HMR client asks for it.
export function freshAstroStyles() {
  const seen = new Set();
  return {
    name: "fresh-astro-styles",
    apply: "serve",
    hotUpdate: {
      order: "pre",
      async handler({ file, server, timestamp }) {
        if (!file.endsWith(".astro")) return;
        const key = `${file}:${timestamp}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (seen.size > 500) seen.clear();
        try {
          await server.environments.ssr?.fetchModule(file);
        } catch {
          // compile error: Astro reports it on its own
        }
      },
    },
  };
}
