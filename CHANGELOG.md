# Changelog

All notable changes to this project are documented in this file.

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