# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NAVE is a browser-native dark-ambient drone synthesizer built on the Web Audio API. It is a **Vite + React + TypeScript single-page app**, shipped as an installable **PWA** and deployed to **GitHub Pages**. All sound is synthesized in the browser — there are no audio asset files, no backend, and no runtime dependencies beyond React.

The entire engine + UI lives in `src/App.tsx` (one default-exported component plus a CSS string at the bottom). Everything else is scaffolding.

## Commands

```bash
npm install        # install deps
npm run dev        # Vite dev server (HMR)
npm run build      # gen icons → tsc -b → vite build  (output in dist/)
npm run preview    # serve the production build locally at /nave-drone/
npm run typecheck  # tsc -b --noEmit, no emit
npm run icons      # regenerate PWA icons into public/ (also run by build)
```

There is no test suite or linter configured; `npm run typecheck` (strict mode) is the gate.

To preview the production build, open the URL **with the base path** — `http://localhost:4173/nave-drone/`, not the bare root (the app is built for a GitHub Pages project subpath).

## Architecture: one fixed signal chain

Audio is **not** rebuilt when parameters change. `start()` constructs the entire node graph once and stores it on the `E` ref (`E.current`, typed as `Engine`). Every later change just ramps the params of those existing nodes via `applyPatch`. The chain:

```
voice A (drone: 5 detuned saws + sub, drift LFO, darkness LP)  ┐
voice B (granular grains over a procedural sample) ───────────►│ mix → filter (LP + LFO1)
voice C (brown-noise floor) ──────────────────────────────────┘            │
                                                                            ▼
                                  preRev → dry + convolver(wet) + freeze delay loop
                                                                            │
                                                            driveIn → shaper(tanh) → wowDelay(LFO)
                                                                            │  (+ hiss highpass)
                                                            limiter (compressor) → master
                                                                            ├─► analyser → destination
                                                                            └─► recDest (MediaRecorder)
```

Key structural facts — internalize these before editing audio code:

- **State vs. live graph are two separate worlds.** React state `patch: Patch` is the UI source of truth; `E.current: Engine` is the audio source of truth. `applyPatch(e, p, ramp)` is the *only* bridge — it pushes a patch onto the graph using `linearRampToValueAtTime` over `ramp` seconds. Different callers use deliberately different ramps: slider edit `0.08s`, `freeze` toggle `0.4s`, `ritual` `7s`, the oracle (Claude) `9s`. Preserve these.
- **The grain scheduler is a lookahead `setInterval`** (every 60ms, scheduling ~180ms ahead) created inside `start()`. It reads the *current* patch through `patchRef.current` (a ref re-synced every render), NOT through React state — the interval closure captures the engine once. New grain params must be read via `patchRef`, not the captured `patch`.
- **Everything is key-locked and tempo-free** by design (header comment). Samples render at a 110 Hz base; grain `playbackRate` is multiplied by `ROOTS[root]/55` so pitch tracks the root. LFO rates are clamped ≤0.5 Hz. Don't add note sequencing or tempo.

## The data model

Three module-level constants (top of `App.tsx`) define the whole parameter space; the TypeScript types are derived from them:

- `RANGES` — `{param: [min, max]}` for every continuous slider param, written `as const`/`satisfies` so `RangeKey = keyof typeof RANGES`. This is the **single source of truth** consumed by `<Slider>`, by `ritual` clamping, and by the oracle's response clamping. Add a slider param here first.
- `ROOTS` / `SPACES` / `SAMPLES` — discrete choices (pitch roots in Hz, reverb IR lengths in seconds, procedural sample names). `RootName`/`SpaceName`/`SampleName` are derived from these.
- `DEFAULT_PATCH: Patch` — initial patch; includes the non-range fields (`root`, `sampleType`, `space`, `freeze`, `seed`).

A `Patch` is one flat object spanning all of the above. `applyPatch` maps each field to one or more audio params, often non-linearly (e.g. `droneDark` simultaneously lowers `droneFilter` cutoff and raises `subGain`). **Adding a param touches four places:** `RANGES`/`DEFAULT_PATCH` + the `Patch`/`Engine` types, the node in `start()`, the mapping in `applyPatch`, and a `<Slider>`/`<Choice>` in the JSX.

## Procedural generation (no assets)

`renderSample(type, sr)` synthesizes each `SAMPLES` entry offline via an `OfflineAudioContext` (additive partials for "bowed metal", formant-filtered saws for "choir", filtered brown noise for "wind tape") and returns an `AudioBuffer`, rendered once in `start()` into `e.samples`. `makeIR` (reverb impulse responses) and `makeBrownNoise` are likewise generated. The seeded PRNG `rng(seed)` (mulberry32) is used only by `ritual` for reproducible re-seeds; the grain scheduler and the IR/noise generators use plain `Math.random()`.

The **app icons are also procedural**: `scripts/gen-icons.mjs` draws NAVE's gothic-arch mark and encodes PNGs using only `node:zlib` (no image libs, no binary assets in git). `npm run build` runs it; the generated `public/pwa-*.png` and `public/apple-touch-icon.png` are gitignored. `public/favicon.svg` is the one hand-authored icon.

## The "oracle" (Claude integration)

`askClaude()` POSTs directly to `https://api.anthropic.com/v1/messages` from the browser, asking the model to mutate the current patch toward a free-text `mood`. The response is expected as a bare JSON patch; the code strips code fences, then **re-clamps every numeric value against `RANGES`** and validates discrete choices against `ROOTS`/`SAMPLES`/`SPACES` before applying — never trust model output to be in range. The call carries no API key (it relies on the host/proxy to supply auth) and won't work offline; treat it as environment-dependent.

## PWA & deployment

- **PWA** is configured via `vite-plugin-pwa` in `vite.config.ts` (`registerType: "autoUpdate"`, manifest inline, Workbox precaches the app shell). Because all audio is synthesized in-browser, precaching the shell is enough to run fully offline (only the oracle needs network).
- **Base path:** GitHub Pages serves a project site from `/<repo>/`. `vite.config.ts` reads `base` from `process.env.VITE_BASE`, defaulting to `/nave-drone/`. The deploy workflow sets `VITE_BASE=/${{ github.event.repository.name }}/`, so a repo rename Just Works — but local `dev`/`preview` use the `/nave-drone/` default. If you rename the repo, the only thing to update by hand is the default in `vite.config.ts`.
- **Deploy:** `.github/workflows/deploy.yml` builds on push to `main` and publishes `dist/` via GitHub Pages (Actions source). First-time setup requires enabling Pages → "Build and deployment" → Source: **GitHub Actions** in the repo settings.

## Conventions worth matching

- The visualizer `useEffect` respects `prefers-reduced-motion`, falling back from `requestAnimationFrame` to a 500ms `setInterval`. New animation should do the same.
- Teardown matters: the final `useEffect` cleanup does `clearInterval(e.grainTimer)` and `e.ctx.close()`. Clean up any new timers/contexts there.
- The aesthetic is deliberate (sepulchral palette, liturgical lowercase labels, em-dashes). Keep UI copy and the dark-ambient framing consistent.
