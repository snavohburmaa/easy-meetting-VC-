# BillyUpdates

Date: 2026-03-25

## Meeting UI and responsiveness

- Improved responsive behavior for meeting UI under 600px.
- Refined top nav and bottom control bar alignment for small screens.
- Kept top nav in a single-row style on small screens when requested.
- Centered and reflowed control buttons for better mobile usability.
- Tuned spacing, button sizing, and wrapping behavior across mobile breakpoints.

## Chat/sidebar responsiveness

- Improved small-screen sidebar fitting between top and bottom bars.
- Added mobile-friendly sidebar behavior with better spacing and panel sizing.
- Made chat input area stick to bottom inside the sidebar panel on mobile.
- Removed redundant sidebar mobile Leave button and kept Close only.

## Signs feature UI redesign

- Reworked hand-sign controls from plain checkboxes into a cleaner control UI:
  - Primary on/off switch
  - Mode selector (Gesture / Finger-spelling)
  - Conditional TTS row
  - Conditional spell action buttons (Send line / Clear)
- Added dynamic hand-sign status text and progressive reveal behavior.
- Updated hint text based on current hand-sign mode and state.

## Signs location change (major UX update)

- Moved hand-sign controls into the existing sidebar Signs tab.
- Removed floating hand-sign box from the video stage.
- Wired the bottom Signs toolbar button to open/close the Signs sidebar tab.
- Kept Signs feed and controls together in one place for better UX.

## Local sign overlay cleanup

- Removed local on-video sign text overlay (for example "Yes / OK") from self tile.
- Kept sign detection and sign feed functionality active in Signs tab.

## Video layout improvements by participant count

- Added adaptive grid layout classes for better multi-user UX:
  - 1 participant: single tile layout
  - 2 participants: two-column layout
  - 3-4 participants: balanced grid layout
  - 5+ participants: denser grid layout
- Updated layout refresh logic when peers join/leave and during cleanup/reset.

## Mic/camera state visibility

- Added media state sync so mic/camera off status can be seen by other participants.
- Added server event relay for participant media state updates (`media:state`).
- Added per-tile visual states and badges for media status.
- Added camera-off tile visual treatment and center camera-off icon.
- Added thin border on video tiles and state-specific border behavior.
- Moved corner state badges to bottom-right for better visibility.
- Updated badges to icon-first style.
- Final behavior change: show only mic-off corner icon; do not duplicate camera-off icon in corner.

## Files updated today

- `public/styles.css`
- `public/index.html`
- `public/app.js`
- `server.js`

## Notes

- JavaScript syntax checks were run for updated client/server files after key changes.
- A UTF encoding issue was corrected during edits so patching and checks could proceed safely.
