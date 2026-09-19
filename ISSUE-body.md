### Astro Info

```block
Astro                    v7.3.3
Node                     v26.3.0
System                   macOS (arm64)
Package Manager          bun
Output                   static
Adapter                  none
Integrations             none
```

Same result with an adapter (second run of the same reproduction):

```block
Astro                    v7.3.3
Node                     v26.3.0
System                   macOS (arm64)
Package Manager          bun
Output                   server
Adapter                  @astrojs/cloudflare
Integrations             none
```

Vite resolved to 8.3.0 in both runs. `@astrojs/cloudflare` 14.3.2.

### If this issue only occurs in one browser, which browser is a problem?

No. Verified in a Chromium browser and with plain `fetch` against the dev server.

### Describe the Bug

Save a `.astro` component once, changing both its markup and its `<style>` block in the same write. With a browser tab open on the route and HMR connected, the markup updates and the CSS does not. The CSS shown is the one from the previous save.

The dev server serves the same scoped CSS through two channels:

1. SSR: the inline `<style data-vite-dev-id="...Target.astro?astro&type=style&index=0&lang.css">` in the HTML response.
2. Client: `GET /src/components/Target.astro?astro&type=style&index=0&lang.css`, which the HMR client refetches on a css update, and which is also injected as a module script on a normal page load, so it overrides the inline style.

Channel 1 is correct. Channel 2 returns the previous generation whenever it is requested before the parent `.astro` file has been re-transformed in the SSR environment. That is exactly the order a browser tab produces: Vite pushes the css update, the tab refetches the style module, and no SSR render of the route has happened in between.

This is an ordering dependency, not a timing race. Delaying the client request after the write does not help, it makes the stale read more likely, because the watcher event has to land first:

| delay before the client request | n | client stale |
| --- | --- | --- |
| 0 ms | 5 | 2/5 |
| 1000 ms | 5 | 5/5 |
| 3000 ms | 5 | 5/5 |

Measured on a browser tab, five consecutive one write edits, each changing markup marker and `--generation` together:

| edit | markup in DOM | `--generation` from `getComputedStyle` |
| --- | --- | --- |
| 1 | `target 1` | `0` |
| 2 | `target 2` | `1` |
| 3 | `target 3` | `2` |
| 4 | `target 4` | `3` |
| 5 | `target 5` | `4` |

After the fifth edit, with no further writes:

- 10 seconds idle: still `4`.
- Normal reload: still `4`.
- Hard reload with cache disabled: still `4`.
- `curl` of the route at the same moment: inline SSR style is `5`.
- `curl` of the style module at the same moment: `4`.
- File on disk: `5`.

So the stale value is held by the dev server, not by the browser cache, and a reload does not clear it. Only another write to the `.astro` file does. This is the "save twice to see the change" behavior.

Reproduction script results, `n = 10` per scenario, two scenarios differing only in which channel is asked first after the write:

| adapter | scenario | n | SSR stale | client stale | cleared by `touch` |
| --- | --- | --- | --- | --- | --- |
| none | route-first | 10 | 0/10 | 0/10 | n/a |
| none | client-first | 10 | 0/10 | 10/10 | 10/10 |
| `@astrojs/cloudflare` 14.3.2 | route-first | 10 | 0/10 | 0/10 | n/a |
| `@astrojs/cloudflare` 14.3.2 | client-first | 10 | 0/10 | 10/10 | 10/10 |

The adapter makes no difference. The defect reproduces with no adapter at all, on the default `static` output.

#### Where it comes from

Line numbers are from the published package, `astro@7.3.3`, `node_modules/astro/dist/vite-plugin-astro/`.

- `index.js:95-122` (`load`) answers `X.astro?astro&type=style&index=N&lang.css` from the in-memory map `astroFileToCompileMetadata`. Line 99 reads the map. Lines 100-106 recompile from disk only when the map has no entry for the file. Line 117 returns `compileMetadata.css[query.index]`. Nothing here compares the cached entry against the file on disk.
- `index.js:197-236` (`transform`) is what fills the map, through `compile.js:26`. Line 203 returns a stub in the client environment, so only a transform in the SSR environment refreshes the entry.
- `hmr.js:3-28` (`handleHotUpdate`) is the other writer. Line 13 checks `isStyleOnlyChanged(oldCode, newCode)`. When the change is style only it recompiles at line 16 and the map is current. When markup or frontmatter changed too, the function falls through and returns `undefined` at line 28 without deleting the entry.

So after a write that touches markup and `<style>` together, Vite invalidates the client style module and the tab refetches it, `load` finds a stale entry that no one deleted, and returns the previous CSS. The value then lives in the client environment module graph and is not invalidated again until the next write.

#### Candidate fix

Deleting the entry when the change is not style only makes `load` take the recompile-from-disk branch. Applied to `dist/vite-plugin-astro/hmr.js` at the end of `handleHotUpdate`:

```js
  if (isStyleOnlyChanged(oldCode, newCode)) {
    // ...existing branch, unchanged
  }
  astroFileToCompileMetadata.delete(ctx.file);
}
```

Measured with that one line added: 0/10 stale in both scenarios, no adapter. I have not checked it against the test suite or against build mode, so treat it as a pointer rather than a patch.

#### Workaround without patching Astro

A dev-only Vite plugin that re-transforms the saved `.astro` file in the SSR environment before Vite notifies the browser:

```js
export function freshAstroStyles() {
  return {
    name: 'fresh-astro-styles',
    apply: 'serve',
    hotUpdate: {
      order: 'pre',
      async handler({ file, server }) {
        if (!file.endsWith('.astro')) return;
        try {
          await server.environments.ssr?.fetchModule(file);
        } catch {}
      },
    },
  };
}
```

Measured with the plugin enabled: 0/10 stale in both scenarios, with and without the adapter, and 5/5 correct on a browser tab.

#### What was not measured

- Other adapters. Only no adapter and `@astrojs/cloudflare` 14.3.2 were run.
- Windows and Linux. All runs were on macOS arm64.
- Whether the candidate fix has side effects on the Astro test suite or on `astro build`.
- Framework component styles (`.svelte`, `.vue`). Only `.astro` scoped styles were tested.

#### Related, not the same

- #17672, closed, fixed by #17611. Content collection entries with asset propagation, where the dev CSS plugin was missing from the fallback `astro` environment. Needs the Cloudflare adapter and content collections. The case here needs neither.
- #17383, merged, and #16957, merged. Both fix stale CSS on the per-route SSR invalidation path in `vite-plugin-hmr-reload`. The SSR channel measures clean here, which is consistent with those fixes landing. What is still stale is the client style module served by `vite-plugin-astro`.
- #17609, open. Tightens client style module matching in `vite-plugin-hmr-reload`. Same area, different code path: it decides which modules get invalidated, not what `load` returns for a module that was invalidated.

I found no open issue describing this behavior.

### What's the expected result?

After one save that changes markup and `<style>` together, the style module served at `X.astro?astro&type=style&index=N&lang.css` reflects the file on disk, so the browser tab shows the new CSS after the first save.

### Link to Minimal Reproducible Example

https://github.com/marks-zyz/astro-dev-stale-scoped-style

The reproduction ships `repro.mjs`, which performs the edits, measures both channels in both orders and exits non-zero when a stale read is observed. StackBlitz is not suitable here because the measurement needs a real file write plus a watcher event and control over the request order.

### Participation

- [ ] I am willing to submit a pull request for this issue.
