#!/usr/bin/env node
// Measures whether the scoped style of a .astro component is served stale by `astro dev`
// after an edit that changes markup and <style> in the same write.
//
// Two channels carry the same CSS in dev:
//   SSR    = the inline <style data-vite-dev-id="...Target.astro?astro&type=style..."> in the HTML
//   CLIENT = GET /src/components/Target.astro?astro&type=style&index=0&lang.css
// The client channel is what a browser tab with HMR connected uses: on a css update Vite makes
// the tab refetch that module URL. The SSR channel is what a full page load uses.
//
// Two scenarios, differing only in WHICH channel is asked first after the write:
//   route-first  : fetch the route (SSR render), then the style module
//   client-first : fetch the style module before any SSR render of the route
//
// Usage (dev server must already be running):
//   node repro.mjs --port 4411 --n 10
//   node repro.mjs --port 4411 --n 10 --scenarios client-first
//
// Exits non-zero when any stale read is observed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(arg("--port", "4411"));
const BASE = `http://localhost:${PORT}`;
const N = Number(arg("--n", "10"));
const TIMEOUT_MS = Number(arg("--timeout", "6000"));
const CLIENT_DELAY_MS = Number(arg("--client-delay", "400"));
const ROUTE = "/";
const TARGET = path.join(ROOT, "src/components/Target.astro");
const STYLE_URL = "/src/components/Target.astro?astro&type=style&index=0&lang.css";

const SCENARIOS = {
  "route-first": { order: "route" },
  "client-first": { order: "client" },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeTarget(generation) {
  const content =
    `---\nconst generation = ${generation};\n---\n` +
    `<div class="target" data-generation={generation} data-mark-${generation}="yes">target ${generation}</div>\n` +
    `<style>\n  .target { --generation: ${generation}; color: #000; }\n</style>\n`;
  fs.writeFileSync(TARGET, content);
}

function hasGeneration(text, generation) {
  const flat = text.replace(/\\n/g, "").replace(/\\"/g, '"').replace(/\s+/g, "");
  return flat.includes(`--generation:${generation};`);
}

async function getRouteHtml() {
  const r = await fetch(BASE + ROUTE, { cache: "no-store" });
  return await r.text();
}

function ssrStyleOf(html) {
  const m = html.match(
    /<style data-vite-dev-id="[^"]*Target\.astro[^"]*">([\s\S]*?)<\/style>/,
  );
  return m ? m[1] : "";
}

async function getClientStyle() {
  const r = await fetch(BASE + STYLE_URL, { cache: "no-store" });
  return await r.text();
}

// The HMR websocket a browser tab keeps open. Its presence is what makes Vite treat the
// client environment as live and push css updates instead of a full reload.
function openHmrSocket() {
  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(`ws://localhost:${PORT}/`, "vite-hmr");
    } catch {
      return resolve(null);
    }
    const t = setTimeout(() => resolve(ws), 3000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
  });
}

async function runScenario(name, cfg) {
  writeTarget(0);
  await sleep(1200);
  await getRouteHtml();
  // register the style module in the client module graph, like a browser does on first load
  await getClientStyle();
  const ws = await openHmrSocket();
  await sleep(300);

  const rows = [];
  for (let g = 1; g <= N; g++) {
    writeTarget(g);
    const t0 = Date.now();
    let ssrFresh = false;
    let clientFresh = false;

    const readSsr = async () => {
      if (ssrFresh) return;
      const html = await getRouteHtml();
      if (hasGeneration(ssrStyleOf(html), g)) ssrFresh = true;
    };
    const readClient = async () => {
      if (clientFresh) return;
      if (hasGeneration(await getClientStyle(), g)) clientFresh = true;
    };

    if (cfg.order === "client") await sleep(CLIENT_DELAY_MS);

    while (Date.now() - t0 < TIMEOUT_MS) {
      if (cfg.order === "client") {
        await readClient();
        await readSsr();
      } else {
        await readSsr();
        await readClient();
      }
      if (ssrFresh && clientFresh) break;
      await sleep(200);
    }

    // If the client read is stale, check whether a new watcher event on the same content
    // (touch) clears it. That shows the stale value is cached, not merely late.
    let healedByTouch = null;
    if (!clientFresh) {
      const now = new Date();
      fs.utimesSync(TARGET, now, now);
      await sleep(600);
      healedByTouch = hasGeneration(await getClientStyle(), g);
    }

    rows.push({ g, ssrFresh, clientFresh, healedByTouch });
    process.stdout.write(ssrFresh && clientFresh ? "." : clientFresh ? "S" : "C");
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  process.stdout.write("\n");

  const ssrStale = rows.filter((r) => !r.ssrFresh).length;
  const clientStale = rows.filter((r) => !r.clientFresh).length;
  const healed = rows.filter((r) => r.healedByTouch === true).length;
  const touched = rows.filter((r) => r.healedByTouch !== null).length;
  return { name, n: N, ssrStale, clientStale, healed, touched };
}

const requested = arg("--scenarios", Object.keys(SCENARIOS).join(","));
const names = requested === "all" ? Object.keys(SCENARIOS) : requested.split(",");

const results = [];
for (const name of names) {
  const cfg = SCENARIOS[name];
  if (!cfg) throw new Error(`unknown scenario: ${name}`);
  process.stdout.write(`\n== ${name} (n=${N}, port ${PORT}) `);
  results.push(await runScenario(name, cfg));
}

console.log("\n| scenario | n | SSR stale | client stale | healed by touch |");
console.log("| --- | --- | --- | --- | --- |");
for (const r of results) {
  const pct = (x) => `${x}/${r.n} (${Math.round((100 * x) / r.n)}%)`;
  const healed = r.touched ? `${r.healed}/${r.touched}` : "n/a";
  console.log(`| ${r.name} | ${r.n} | ${pct(r.ssrStale)} | ${pct(r.clientStale)} | ${healed} |`);
}

writeTarget(0);
const failed = results.some((r) => r.ssrStale > 0 || r.clientStale > 0);
console.log(failed ? "\nRESULT: stale reads observed" : "\nRESULT: no stale reads");
process.exit(failed ? 1 : 0);
