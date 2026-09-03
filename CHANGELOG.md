# Changelog

All notable changes to this project are documented in this file.

## v0.2.0

### Added
- Raw screenshot roles on steps: `before*` and `after*` frames alongside primary annotated images.
- Smart after-click capture with optional toolbar override (`After`) for result-state screenshots.
- Layered page extraction (`page-extractor`) with accessible-name, parent-region, and page-frame context.
- New `screenshot` event type for manual camera captures so they are persisted as real steps.
- Session edit persistence API (`/sessions/:id/edits`) and editor UI panel showing recorded page edits.
- New event/step metadata for parent context, accessibility state, and after-outcome details.

### Changed
- Capture pipeline now acknowledges click replay earlier (after raw capture) to reduce perceived interaction delay.
- Screenshot capture uses optimized encoding flow and keyed IDB screenshot reads for lower memory pressure.
- Theme emulation writes `data-color-scheme`, re-forces light mode after navigation, and flags same-frame dual captures.
- Finalize/merge annotation now runs light+dark annotation in parallel while preserving raw canonical images.
- Export now includes clean before frames and after-result frames when present.
- Session editor step cards now support frame tabs (Annotated/Clean/Result) and theme toggles.
- Modal tracking now emits open and close events; keyboard Enter/Space on controls is captured as click-equivalent intent.

### Fixed
- Skip-highlight decisions are patched to server state to avoid losing prompt decisions after early flushes.
- Cross-origin navigation events no longer force redundant recapture when screenshots already exist.
- Edit mode persistence now includes hidden-element edits and re-application on theme-driven DOM churn.

## v0.1.1

### Added
- Full-viewport screenshots for all steps (no cropping).
- Numbered multi-action grouped steps (1, 2, 3) for related same-area actions.
- Popup-aware merge flow for trigger + ephemeral UI actions.
- Per-click annotate prompt with Keep/Skip behavior.
- Merge prompts shown after each boundary in a detected chain (A+B, then A+B+C).

### Changed
- Screenshot capture reliability improved with stronger click gating and replay timing.
- Dark-theme capture fidelity improved with longer settle timing and paint flush behavior.
- WebP output changed to quality-based compression (`quality: 85`) for smaller files.
- Numbered annotation circles now prefer open-space sides to avoid overlapping important text.
- Merged-step re-annotation now uses raw event screenshots to avoid stale overlays.
- Numbered merged screenshots do not draw connector arrows.
- Single-step screenshots keep the standard highlight arrow.

### Fixed
- Floating toolbar now dismisses immediately on Stop.
- Highlight targeting tightened to avoid promoting to oversized generic containers.
- Merge detection and prompt flow refined for 2-step and 3-step ephemeral chains.

## v0.1.0

### Added
- Initial Chrome/Edge extension recording flow.
- Dual-theme screenshot capture (light and dark).
- Server-side step generation and screenshot annotation pipeline.
- Editor for reviewing, reordering, and editing generated steps.
- ZIP export with Markdown plus screenshot assets.