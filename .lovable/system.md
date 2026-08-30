# Arena Design System

A dark, high-contrast arcade game-show design system for fast, competitive
mobile-first play surfaces (trivia rounds, lobbies, reward tracks, leaderboards).

## Philosophy

- **Dark first.** The canvas is near-black with a subtle dotted texture. Light
  themes are not supported.
- **Neon carries meaning, never decoration.** Lime = correct / progress / primary
  action. Red = wrong / danger / versus. Purple = daily & featured. Amber = skip
  and neutral warnings.
- **Loud display type, quiet mono labels.** Headings use the condensed display
  face in uppercase. Every small label, timer, code, and stat uses the mono face
  in uppercase with wide tracking.
- **Chunky, tappable, physical.** Primary buttons carry a hard bottom shadow that
  compresses on press. Targets are never below 44px tall.

## Hard constraints

- Never hardcode a color, radius, shadow, spacing step, or font family. Use the
  CSS custom properties from `theme/tokens.css` (e.g. `var(--color-lime)`,
  `var(--radius-lg)`, `var(--space-4)`).
- Never add inline `style` attributes for values the tokens cover. Component
  variants are exposed as props (`variant`, `size`, `tone`), never as boolean
  styling props or ad-hoc class strings.
- Every component forwards `className`, spreads remaining props, and forwards its
  ref onto the underlying semantic element.
- Actions are `<button>`, navigation is `<a>`, inputs are labelled. Focus-visible
  outlines use `--color-focus` and are never removed.
- Compose existing components (`Button`, `Card`, `Badge`) before writing new ones.

## Voice

Terse, competitive, second person. `PLAY TODAY'S PACK`, `NEXT ROUND (2/5)`,
`COLLECT REWARD`. No sentence case in chrome, no exclamation marks except for
result banners (`WRONG!`, `CORRECT!`).

See `.lovable/rules/design-tokens.md` and `.lovable/rules/components.md` for the
generated token and component reference.
