# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NAVE is a single-file, dependency-light dark-ambient drone synthesizer that runs entirely in the browser on the Web Audio API. The whole app is `nave-drone-engine.jsx` — one default-exported React component plus a CSS string at the bottom. There is no `package.json`, build config, test suite, or git repo here; the `.jsx` is meant to be dropped into a React host (e.g. an artifact runtime or a Vite/CRA `App.jsx`) that provides React and a bundler. There are no project-specific build/lint/test commands.

## Mental model: one fixed signal chain

Audio is not rebuilt when parameters change. `start()` constructs the **entire node graph once** and stores it on the `E` ref (`E.current`, the object `e`). Every later change just ramps the gains/frequencies of those existing nodes via `applyPatch`. Understanding the code means understanding this fixed chain:

```
voice A (drone: 5 detuned saws + sub, drift LFO, darkness LP)  ┐
voice B (granular grains over a procedural sample) ───────────►│ e.mix → e.filter (LP + LFO1)
voice C (brown-noise floor) ──────────────────────────────────┘            │
                                                                            ▼
                                  e.preRev → dry + convolver(wet) + freeze delay loop
                                                                            │
                                                            e.driveIn → shaper(tanh) → wowDelay(LFO)
                                                                            │  (+ hiss highpass)
                                                            e.limiter (compressor) → e.master
                                                                            ├─► analyser → destination
                                                                            └─► recDest (MediaRecorder)
```

Key structural facts to keep in mind before editing:
- **State vs. live graph are two separate things.** React state `patch` is the source of truth for the UI; `E.current` is the live audio graph. `applyPatch(e, p, ramp)` is the *only* bridge — it pushes a patch onto the graph using `linearRampToValueAtTime` over `ramp` seconds. Different callers use very different ramps deliberately: a slider edit ramps 0.08s, `freeze` toggles 0.4s, `ritual` crossfades over 7s, Claude's edits over 9s ("arrive as weather"). Preserve these when touching `update`/`ritual`/`askClaude`.
- **The grain scheduler is a lookahead `setInterval`** (every 60ms, scheduling ~180ms ahead) set up inside `start()`. It reads the *current* patch through `patchRef.current` (a ref kept in sync each render at line ~148), NOT through React state — because the interval closure captures the engine once. If you add grain params, route them through `patchRef`, not the captured `patch`.
- **Everything is key-locked and tempo-free** by design (see the header comment). Samples render at a 110 Hz base; grain `playbackRate` is multiplied by `ROOTS[root]/55` so pitch tracks the root. LFO rates are clamped ≤0.5 Hz. Don't introduce note sequencing or tempo.

## The data model

Three module-level constants define the whole parameter space:
- `RANGES` — `{param: [min, max]}` for every continuous slider param. This is the **single source of truth** consumed by the `<Slider>` component, by `ritual` clamping, and by `askClaude` clamping. Adding a slider param means adding it here first.
- `DEFAULT_PATCH` — initial patch; also includes the non-range fields (`root`, `sampleType`, `space`, `freeze`, `seed`).
- `ROOTS` / `SPACES` / `SAMPLES` — the discrete choices (pitch roots in Hz, reverb IR lengths in seconds, procedural sample names) rendered as `<Choice>` chips.

A "patch" is one flat object spanning all of the above. `applyPatch` maps each patch field to one or more audio params, often non-linearly (e.g. `droneDark` simultaneously lowers `droneFilter` cutoff and raises `subGain`). When adding a param, you touch four places: `RANGES`/`DEFAULT_PATCH`, the node in `start()`, the mapping in `applyPatch`, and a `<Slider>`/`<Choice>` in the JSX.

## Procedural sample bank

There are no audio asset files. `renderSample(type, sr)` synthesizes each of the three `SAMPLES` offline via an `OfflineAudioContext` (additive partials for "bowed metal", formant-filtered saws for "choir", filtered brown noise for "wind tape"), returning an `AudioBuffer`. These are rendered once during `start()` and stored in `e.samples`. `makeIR` (reverb impulse responses) and `makeBrownNoise` are likewise generated, not loaded. The seeded PRNG `rng(seed)` (mulberry32) is used only by `ritual` for reproducible re-seeds; the grain scheduler and IR/noise generators use plain `Math.random()`.

## The "oracle" (Claude integration)

`askClaude()` POSTs directly to `https://api.anthropic.com/v1/messages` from the browser, asking the model to mutate the current patch toward a free-text `mood`. The response is expected as a bare JSON patch; the code defensively strips code fences, then **re-clamps every returned value against `RANGES`** and validates discrete choices against `ROOTS`/`SAMPLES`/`SPACES` before applying — never trust the model's output to be in range. Note this call has no API key/auth header and relies on the host environment to supply one; treat the fetch as host-dependent.

## Conventions worth matching

- The visualizer (`useEffect` on `started`) respects `prefers-reduced-motion`: it falls back from `requestAnimationFrame` to a 500ms `setInterval`. Any new animation should do the same.
- Teardown matters: the final `useEffect` cleanup does `clearInterval(e.grainTimer)` and `e.ctx.close()`. If you add timers or contexts, clean them up there.
- The aesthetic is deliberate (sepulchral palette, liturgical lowercase labels, em-dashes). Keep UI copy and the dark-ambient framing consistent with the existing tone.
