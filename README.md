# Stale scoped style in `astro dev`

Minimal reproduction: after one save that changes the markup and the `<style>` block of a `.astro`
component together, the dev server serves the previous generation of that component's scoped CSS
on `X.astro?astro&type=style&index=0&lang.css`, if that module is requested before the route is
rendered in the SSR environment. A browser tab with HMR connected always produces that order, so
the tab shows the new markup with the old CSS until the file is written again.

Pinned: `astro@7.3.3`, `@astrojs/cloudflare@14.3.2`.

## Layout

- `src/components/Target.astro` is the file the script edits. Its markup and its `<style>` both
  carry a generation number, so a stale read is unambiguous.
- `src/pages/index.astro` renders it.
- `repro.mjs` performs the edits and measures both channels.
- `plugins/fresh-astro-styles.mjs` is a dev-only workaround, off by default.

Two environment switches in `astro.config.mjs`, both off by default:

| variable | effect |
| --- | --- |
| `ADAPTER=cloudflare` | load `@astrojs/cloudflare`, so dev runs through workerd |
| `FRESH_STYLES=1` | load the workaround plugin |

## Run

```sh
bun install
bun run dev          # terminal 1, port 4411
bun repro.mjs        # terminal 2
```

With the adapter:

```sh
bun run dev:cloudflare   # terminal 1, port 4412
bun repro.mjs --port 4412
```

With the workaround:

```sh
FRESH_STYLES=1 bun run dev
bun repro.mjs
```

Options: `--port`, `--n` (iterations per scenario, default 10), `--scenarios`
(`route-first`, `client-first`, or both), `--client-delay` (ms to wait after the write before the
client request, default 400), `--timeout`.

## What the script does

Per iteration it writes `Target.astro` once, changing a marker in the markup and the
`--generation` custom property in the `<style>` block, then reads the same CSS through two
channels until both are current or the timeout expires:

- SSR: the inline `<style data-vite-dev-id="...Target.astro...">` in the HTML of `/`.
- Client: `GET /src/components/Target.astro?astro&type=style&index=0&lang.css`.

The two scenarios differ only in which channel is read first after the write. A vite-hmr
websocket stays open for both, and the style module is fetched once before the loop, so it exists
in the client module graph the way it does for a real tab.

When the client read is stale, the script touches the file and reads once more, to show that the
value is cached rather than late.

It exits non-zero when any stale read is observed.

## Expected

```
| scenario | n | SSR stale | client stale | healed by touch |
| --- | --- | --- | --- | --- |
| route-first | 10 | 0/10 (0%) | 0/10 (0%) | n/a |
| client-first | 10 | 0/10 (0%) | 0/10 (0%) | n/a |

RESULT: no stale reads
```

## Actual

```
| scenario | n | SSR stale | client stale | healed by touch |
| --- | --- | --- | --- | --- |
| route-first | 10 | 0/10 (0%) | 0/10 (0%) | n/a |
| client-first | 10 | 0/10 (0%) | 10/10 (100%) | 10/10 |

RESULT: stale reads observed
```

Identical with and without `@astrojs/cloudflare`. With `FRESH_STYLES=1` the expected table is the
one that prints.
