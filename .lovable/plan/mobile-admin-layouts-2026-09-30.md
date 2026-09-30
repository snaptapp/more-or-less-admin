# Mobile admin layouts

## Goal
Make every admin screen usable at phone widths without weakening the existing desktop dashboard.

## Build
- Replace the desktop-only sidebar on small screens with a compact sticky header and an accessible menu that opens the full navigation and account controls.
- Standardize narrow-screen page headers, filters, tabs, buttons, forms, stat grids, charts, detail lists, alerts, and chat panels so controls fill available width and remain easy to tap.
- Give data-heavy views a deliberate mobile treatment: preserve tables where comparison matters with clear horizontal-scroll affordances, sticky action columns where practical, and remove nested framing that wastes phone width.
- Add focused responsive overrides for the unusual fixed-column layouts in Content, Moderation, Daily Blitz, Remote Config, Analytics, Audit, Roles, Players, and Taxonomy.
- Preserve the Arena visual language and all existing data/actions.

## Validation
- Check all admin URLs at a 390px phone viewport and a desktop viewport.
- Verify navigation opening/closing, page scrolling, table access, filters, and key action buttons.
- Confirm there is no unintended page-level horizontal overflow and the project quality gate remains green.

## Technical details
- Keep responsive behavior primarily in the shared admin stylesheet so all views inherit consistent rules.
- Add only small semantic class hooks where inline fixed layouts cannot be safely overridden.
- Continue using existing Arena tokens and design-system controls; no backend or data-contract changes.
