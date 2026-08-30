# more or less admin site — Guidelines

## Components

The design system exports these components — import them from `@ws-379cae16210c2fefdfa6/18942472-e8d0-4bea-a978-e99273b6602e` and compose them before building anything from scratch:

`AnswerButton`, `Badge`, `Button`, `CardLabel`, `CardTitle`, `Card`, `CodeInput`, `LeaderboardRow`, `NavBar`, `ProgressBar`, `ResultBanner`, `ShotClock`, `StatValue`, `TabBar`, `TierRow`, `TopicTile`

Per-component details (import stanzas, props, variants, examples) live in `.lovable/rules/libraries/{slug}/components.md` — on disk, not auto-loaded. Read that file or the component source when the name alone isn't enough.

## Theme Files

The design system's theme is delivered through the following files. The author's original source files carry the full wiring the design system needs — variable declarations, framework-specific directives, provider objects, etc. — and are the canonical import target.

- `@ws-379cae16210c2fefdfa6/18942472-e8d0-4bea-a978-e99273b6602e/design-system/theme/tokens.css` (source — preferred import)
- `@ws-379cae16210c2fefdfa6/18942472-e8d0-4bea-a978-e99273b6602e/dist/tokens.css` (auto-generated flat list of CSS custom properties — a raw-values fallback only; does NOT carry framework-specific wiring that the source files above provide)

