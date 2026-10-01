# Site-wide mobile layouts

## Goal
Extend the completed admin mobile work to every remaining user-facing route and shared Arena component without changing application behavior.

## Build
- Audit the root/public route surface and make the shared page foundation prevent viewport overflow, including long text and safe sizing defaults.
- Harden shared Arena controls for narrow screens: navigation rows, buttons, cards, badges, inputs, answer choices, statistics, result banners, leaderboards, tabs, timers, and progress elements.
- Keep fixed-size controls stable, let text containers shrink or wrap safely, retain 44px touch targets, and preserve the existing desktop presentation.
- Add focused automated checks covering shared controls at very small phone, phone, tablet, and desktop widths.

## Validation
- Render the public entry and a representative shared-component showcase at 320px, 390px, 768px, and 1280px.
- Confirm no page-level horizontal overflow, clipped text, overlapping controls, or inaccessible actions.
- Run the relevant tests and confirm the preview build remains green.

## Technical details
- Keep responsive behavior in the existing Arena token stylesheet and global page foundation.
- Reuse design tokens and existing components; no Firebase, authentication, or game-data changes.
- The only non-admin content route currently redirects to Admin, so public-route work is limited to the root foundation while shared components receive the substantive responsive pass.
