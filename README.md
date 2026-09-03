# DocExt v0.2.0

A Chrome/Edge extension that records your browser actions, captures screenshots in both light and dark themes, and generates step-by-step documentation. Export everything as a ZIP with Markdown and WebP images.

## Release Notes

For full version history and detailed release notes, see `CHANGELOG.md`.

## Features

- **Action recording**: captures clicks, text input, dropdowns, form submissions, page navigation, and modals
- **Dual-theme screenshots**: automatically toggles between light and dark themes to capture both versions
- **Element highlighting**: adds an orange border and arrow to the clicked element; grouped multi-action steps use numbered circles
- **Full-viewport screenshots**: every screenshot shows the complete page context with no cropping
- **Frame variants per step**: view **Annotated**, **Clean** (raw before-click), and optional **Result** (after-click) frames
- **Grouped steps with numbered annotations**: multiple related clicks on the same page area are combined into one card with a single annotated screenshot
- **Popup-aware merging**: trigger → popup-item sequences are merged into one step using the popup-open screenshot
- **Per-click annotate prompt**: **Keep**, **Skip**, or **After** (force result capture)
- **Inline page editing**: edit text/hide elements directly on the live page while recording
- **Persistent page edits**: edits are saved to the session and shown in the editor
- **Auto-generated step titles**: layered extraction uses accessible names, parent region context, and page frame details
- **Drag-and-drop editor**: reorder, rename, or delete steps after recording
- **ZIP export**: download a `documentation.md` file alongside all screenshots (`step01-light.webp`, `step01-dark.webp`, etc.)

## Project Structure

```
packages/
  shared/       Shared TypeScript types and utilities
  extension/    Chrome Extension (Manifest V3)
  server/       Express + SQLite backend
  editor/       React web app for viewing and editing sessions
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Chrome or Edge

### Install and Run

```bash
npm install
npm run dev              # starts server + editor at http://localhost:3001
npm run build:extension  # builds the Chrome extension
```

### Load the Extension

1. Run `npm run build:extension`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer Mode**
4. Click **Load unpacked** and select `packages/extension/dist`

### How to Use

1. Click the DocExt icon in the browser toolbar and press **Start Recording**
2. Use the website normally. A floating bar at the bottom shows the action count and timer.
3. After each click, an **"Annotate …?"** prompt appears in the toolbar. Choose **Keep** (default), **Skip**, or **After** (capture post-click result).
4. Click **Edit Page** on the floating bar to change text directly on the page
5. Click **Stop Recording**. The editor opens automatically with the generated steps.
6. Reorder, edit, or delete steps as needed
7. Click **Export ZIP** to download your documentation

## About Theme Flicker (Important)

DocExt captures each visual step in both light and dark mode. To do this, the extension briefly switches the page theme during capture.

- **What you may notice**: a quick light/dark flash right after certain actions (especially clicks in menus, popups, and modals).
- **Why this happens**: the extension takes two screenshots per visual step (light first, dark second), then restores the original theme.
- **Why clicks sometimes feel delayed**: DocExt pauses the original click, captures the pre-click frame, then replays the click to preserve accurate before-action screenshots.
- **What is normal**: a short visual flicker and slight interaction delay during recording.
- **What is not normal**: controls becoming permanently unclickable, action counts increasing rapidly without interaction, or repeated looping captures.

If behavior feels stuck, stop recording and start a fresh session on the current page.

## Behavior Notes (What to Expect)

These behaviors are intentional and help keep screenshots and steps consistent:

- **Full-viewport screenshots**: every screenshot shows the complete page, and the highlight annotation is overlaid at the element's exact position without any cropping.
- **Multi-action steps**: if you click several related elements in the same area of the page within 30 s, they are automatically grouped into one step. The screenshot is taken before any replays, so all annotated elements are visible together.
- **Popup / trigger merging**: clicking a button that opens a popup, then clicking an item inside the popup, produces a single merged step. The screenshot used is the one captured while the popup was open, so both the trigger button (annotation 1) and the popup item (annotation 2) are visible.
- **Visual vs non-visual events**: dual-theme screenshots are prioritised for visual actions (clicks, modal open/close, page navigation, manual screenshots). Text/select/submit events may be recorded without full dual capture to reduce noise and extra flicker.
- **Typing order around clicks**: pending text input is flushed before a click on another control (for example, clicking **Save** after editing a field), so the typed step appears before the save/click step.
- **Submit deduping**: if a submit fires immediately after a captured click, DocExt may treat it as the same user intent to avoid duplicate steps.
- **Highlight targeting is best-effort**: DocExt prefers the clicked control, but highly nested custom UI components can still occasionally highlight a text wrapper or nearby interactive parent.
- **Cross-origin navigation capture**: when moving between different origins (for example, app → OAuth provider), navigation capture may appear as its own step.
- **Theme-aware capture fallback**: if light and dark frames are visually identical for a step, the session marks that capture as `same` and the editor can hide duplicate panes.
- **Step order stability**: events are uploaded in deterministic order, but very close timestamps from app-side async updates can still create edge-case grouping differences in generated step text.

If a single flow is critical (onboarding, login, checkout), run one clean recording for that flow and avoid switching tabs mid-recording.

## Development

```bash
npm run dev              # server + editor with hot reload
npm run build            # build everything
npm run build:extension  # build the extension only
npm run build:editor     # build the editor only
npm run build:server     # build the server only
```

- Server API: `http://localhost:3001/api`
- Editor UI: `http://localhost:3001` (served by the server with Vite middleware in dev)
- Database: `./data/docext.db` (SQLite)
- Screenshots: `./data/screenshots/` (WebP, quality 85)

## Key Files

### Extension (`packages/extension`)

| File | What it does |
|------|-------------|
| `src/content.ts` | Listens for DOM events, manages toolbar/edit mode, controls click gate/replay timing, and triggers smart after-click capture decisions. |
| `src/background.ts` | Service worker that manages recording lifecycle, dual-theme capture, upload batching, and after-capture storage. |
| `src/lib/floating-toolbar.ts` | Shadow DOM toolbar UI including the inline "Annotate …?" prompt row with Keep/Skip/After. |
| `src/lib/element-resolver.ts` | Builds CSS selectors and extracts text, labels, and context from DOM elements |
| `src/lib/page-extractor.ts` | Layered extraction for control/region/page frame context and after-state outcome detection |
| `src/lib/event-filter.ts` | Deduplicates clicks and debounces text input events |
| `src/lib/idb-store.ts` | IndexedDB storage for events and screenshots; includes skip-highlight and after-screenshot updates |
| `src/popup/App.tsx` | The extension popup UI |

### Server (`packages/server`)

| File | What it does |
|------|-------------|
| `src/routes/sessions.ts` | API routes for sessions, events, screenshots, page edits, and steps; runs server-side annotation on finalize |
| `src/routes/export.ts` | Generates the ZIP export with Markdown and images |
| `src/lib/step-generator.ts` | Turns raw recorded events into human-readable steps; handles same-area grouping, trigger+ephemeral merging, deduplication, and before/after frame mapping |
| `src/lib/screenshot-annotator.ts` | Server-side screenshot annotation using `sharp` + SVG overlays; draws single highlights (box + arrow) and numbered group highlights |
| `src/lib/exporter.ts` | Builds the Markdown file and packages it with screenshots |
| `src/lib/screenshot-store.ts` | Saves screenshots to disk and converts them to WebP |
| `src/db/` | Database schema and setup (Drizzle ORM + SQLite) |

### Editor (`packages/editor`)

| File | What it does |
|------|-------------|
| `src/pages/SessionList.tsx` | Lists all recorded sessions |
| `src/pages/SessionEditor.tsx` | Step editor with drag-and-drop reordering, inline editing, and session page-edits list |
| `src/components/StepCard.tsx` | Displays a single step with frame tabs (Annotated/Clean/Result), theme toggles, and sub-step list |
| `src/components/ConfirmModal.tsx` | Confirmation dialog for destructive actions |
| `src/components/ExportPanel.tsx` | The export button |

## How It Works

1. **Recording**: The content script intercepts `pointerdown` events with `capture: true`, immediately calls `preventDefault()` and freezes the main-world click gate. This preserves the exact page state (hover states, open dropdowns, etc.) before the screenshot. After the screenshot is taken, the gate releases and the click is replayed.

2. **Screenshots**: The service worker hides the toolbar, captures light and dark full-viewport frames, restores theme, and stores raw screenshots as canonical source images.

3. **Annotate prompt**: After each click replays, the toolbar shows "Annotate …?" with **Keep**, **Skip**, and **After**. Skip marks the event for no overlay; After forces a post-click result capture.

4. **Step generation**: On finalize, the server groups consecutive same-area clicks into multi-action steps (within 250 px center-to-center, same page, same scroll position). It then merges trigger → ephemeral pairs (e.g. open-menu → select-item) using the popup-open screenshot. Consecutive input events on the same field are merged, and duplicate adjacent steps are removed.

5. **Annotation**: The server reads each raw before-click screenshot, computes highlight positions, and generates annotated derivatives (light/dark) from the raw source using `sharp`.

6. **Edit persistence**: While recording, page edits are stored per-session in extension storage and reapplied by MutationObserver. On upload/finalize they are persisted to the backend session and shown in the editor.

7. **Export**: Produces a ZIP with `documentation.md` and `screenshots/` including annotated images plus clean/after variants when available.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Extension | TypeScript, React 19, Chrome Manifest V3, Shadow DOM |
| Server | Node.js, Express, better-sqlite3, Drizzle ORM, sharp, archiver |
| Editor | React 19, Vite, Tailwind CSS, React Query, dnd-kit |
