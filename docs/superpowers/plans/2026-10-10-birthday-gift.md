# Birthday Gift Implementation Plan

> Superseded by the continuous-reading revision in STATUS.md. The old next/previous scene flow and giftJourney reducer described below have been removed in response to feedback. Current content lives in src/content/giftCopy.ts and consistently uses 张珂欣.

> **For agentic workers:** Implement this plan task-by-task with the available execution tools. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Turn the existing birthday animation site into a personal, gently affectionate gift using the supplied portrait.

**Architecture:** Keep the existing particle and gesture engines. Add a sequential gift journey in App, with separate photo and letter scenes, optional gesture controls, and a deliberate wish action before the finale. Reuse the current dark night and coral palette.

**Tech Stack:** React 19, TypeScript, Vite, native CSS, existing Canvas and MediaPipe.

## Global Constraints

- Work in the current project; preserve unrelated edits and the existing development server.
- Use only the supplied real photo. Do not invent shared memories, relationship status, or sender name.
- Default entry never requests camera permission. Camera is explicitly optional and can be cancelled/retried.
- Preserve all four particle scenes, keyboard shortcuts in animation scenes, reduced motion, and music controls.
- No new runtime dependencies, publishing, or external uploads.

### Task 1: Portrait presentation

**Files:** src/components/PhotoMoment.tsx, src/components/PhotoMoment.css, src/assets/kexin-birthday.jpg.

**Interface:** PhotoMoment renders the photo scene; export birthdayPortrait for App's cover. Native dialog supports viewing the uncropped photo and closing with Escape.

- [x] Copy the supplied photo into local assets and retain original proportions.
- [x] Create a portrait presentation and accessible full-photo viewer, with reduced motion styling.

### Task 2: Gift journey and copy

**Files:** src/App.tsx, src/App.css, src/index.css, src/components/giftJourney.ts.

**Interface:** GiftScene = galaxy | birthday | photo | letter | closing | pig. Main route follows galaxy → birthday → photo → letter → closing; pig is an optional extra.

- [x] Create a cover with the portrait and one clear entry action.
- [x] Add previous/next navigation, photo scene, readable short letter, wish-ready state and fireworks finale.
- [x] Keep pause/music controls accessible; place technical help in an optional panel.
- [x] Decouple camera from entry and guard pending permission requests against cancellation/unmount.
- [x] Limit animation keyboard shortcuts and gestures to appropriate scenes so reading is not interrupted.
- [x] Replace generic/technical copy with natural Chinese. Keep names intact across line breaks.

### Task 3: Supporting language and verification

**Files:** src/components/gestureOnboarding.ts, src/components/gestureFeedbackState.ts, src/components/cameraFallback.ts, related tests, index.html.

- [x] Align guide and feedback labels with 星光 / 生日快乐 / 小彩蛋 / 许个愿; update fallback instructions to the actual retry/navigation controls.
- [x] Verify journey/wish transitions with focused behavior tests and run existing suite, lint, production build and dist checks.
- [x] Inspect desktop and 390px viewport, photo viewer, navigation, wish action, help, keyboard shortcuts, camera cancellation, and no-camera entry in the browser. Check reduced-motion coverage through the existing tests and CSS; actual camera recognition and Safari remain untested.
- [x] Review final diff and show the finished local preview.

