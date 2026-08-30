# Arena Widget Kit (Flutter)

Drop-in shared widgets for the More or Less Flutter client. Copy this folder to
`client/lib/ui/kit/` — the relative imports (`../../core/...`) assume that path.

All colour comes from the active `ArcadeTokens` ThemeExtension, so in-game
skinning and high-contrast mode keep working. No hardcoded hex, no per-screen
`BoxDecoration` copies.

## Files

| File | Widget | Replaces / consolidates |
| --- | --- | --- |
| `arena_tone.dart` | `ArenaTone` | ad-hoc `AppColors.volt / coral / purple` picks |
| `arena_breakpoints.dart` | `ArenaLayout`, `ArenaContentColumn` | scattered `MediaQuery.size.width` checks |
| `arena_button.dart` | `ArenaButton`, `ArenaButton.icon` | one-off ElevatedButton/Container buttons |
| `arena_card.dart` | `ArenaCard` | mode_card / daily_challenge_card / vault tier chrome |
| `arena_badge.dart` | `ArenaBadge` | inline pill Containers |
| `arena_stat_tile.dart` | `ArenaStatTile` | stat_hero_display variants |
| `arena_section_header.dart` | `ArenaSectionHeader` | per-screen header Rows |
| `arena_progress_bar.dart` | `ArenaProgressBar` | round + vault progress bars |
| `arena_shot_clock.dart` | `ArenaShotClock` | tachometer_countdown (simplified, accessible) |
| `arena_choice_buttons.dart` | `ArenaChoiceButtons` | MORE / LESS / SKIP pedal rail |
| `arena_empty_state.dart` | `ArenaEmptyState` | empty_profile_state, empty_versus_state, locked_store_state |

## Design decisions baked in

- **Red means failure only.** `ArenaTone.danger` is reserved for wrong answers
  and destructive actions; Versus should use `neutral`/`featured` chrome.
- **Never colour-only.** MORE/LESS carry arrow icons, words and fixed positions;
  the shot clock announces seconds as text; badges always have a label.
- **Touch targets ≥ 48dp** on every interactive widget.
- **Visible focus** rings on button and card (keyboard + desktop web).
- **One radius language**: 18 cards, 14 buttons, pill badges.
- **Responsive by default**: `ArenaContentColumn` caps line length on tablet and
  desktop instead of stretching mobile layouts.

## Usage

```dart
import '../kit/arena_kit.dart';

ArenaContentColumn(
  child: Column(
    children: [
      ArenaSectionHeader(
        eyebrow: 'Daily pack',
        title: 'Animals & Nature',
        trailing: const ArenaBadge(label: '5 rounds', tone: ArenaTone.featured),
      ),
      const SizedBox(height: 16),
      ArenaProgressBar(value: 0.6, segments: 5, label: 'Round 3 / 5'),
      const SizedBox(height: 16),
      ArenaCard(
        tone: ArenaTone.featured,
        emphasis: ArenaCardEmphasis.accent,
        onTap: startDaily,
        child: const Text('A cheetah can sprint at 40 mph.'),
      ),
      const SizedBox(height: 16),
      ArenaChoiceButtons(onChoice: submit, locked: hasAnswered),
      const SizedBox(height: 16),
      ArenaButton(
        label: 'Next round',
        trailingIcon: Icons.arrow_forward_rounded,
        fullWidth: true,
        onPressed: next,
      ),
    ],
  ),
)
```

## Migration order

1. `ArenaButton` + `ArenaBadge` (mechanical, low risk).
2. `ArenaCard` across play hub, vault and daily screens.
3. `ArenaChoiceButtons` in the active round — behaviour change, test the
   swipe/keyboard paths in `game_keyboard_shortcuts.dart` alongside it.
4. `ArenaEmptyState` to delete the four bespoke empty widgets.
