import 'package:flutter/material.dart';

import '../../core/constants/app_spacing.dart';
import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_breakpoints.dart';
import 'arena_tone.dart';

enum ArenaChoice { more, less, skip }

/// The MORE / LESS / SKIP answer rail.
///
/// Design fixes baked in:
/// * choices are distinguished by icon + word + position, not colour alone
/// * MORE and LESS are equal-weight siblings; only outcomes use volt/coral
/// * SKIP is amber and visually subordinate
/// * locks after answer and shows the selected choice + the correct one
/// * stacks on mobile, sits in a single row from tablet up
class ArenaChoiceButtons extends StatelessWidget {
  const ArenaChoiceButtons({
    super.key,
    required this.onChoice,
    this.selected,
    this.correct,
    this.locked = false,
    this.showSkip = true,
  });

  final ValueChanged<ArenaChoice> onChoice;
  final ArenaChoice? selected;
  final ArenaChoice? correct;
  final bool locked;
  final bool showSkip;

  @override
  Widget build(BuildContext context) {
    final layout = ArenaLayout.of(context);
    final buttons = <Widget>[
      _ChoicePedal(
        choice: ArenaChoice.less,
        label: 'LESS',
        icon: Icons.south_rounded,
        hint: 'Lower than shown',
        selected: selected == ArenaChoice.less,
        correct: correct == ArenaChoice.less,
        revealed: correct != null,
        locked: locked,
        onTap: () => onChoice(ArenaChoice.less),
      ),
      _ChoicePedal(
        choice: ArenaChoice.more,
        label: 'MORE',
        icon: Icons.north_rounded,
        hint: 'Higher than shown',
        selected: selected == ArenaChoice.more,
        correct: correct == ArenaChoice.more,
        revealed: correct != null,
        locked: locked,
        onTap: () => onChoice(ArenaChoice.more),
      ),
    ];

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (layout.isWide)
          Row(
            children: [
              Expanded(child: buttons[0]),
              const SizedBox(width: AppSpacing.md),
              Expanded(child: buttons[1]),
            ],
          )
        else ...[
          buttons[1],
          const SizedBox(height: AppSpacing.sm),
          buttons[0],
        ],
        if (showSkip) ...[
          const SizedBox(height: AppSpacing.sm),
          _SkipButton(
            locked: locked,
            selected: selected == ArenaChoice.skip,
            onTap: () => onChoice(ArenaChoice.skip),
          ),
        ],
      ],
    );
  }
}

class _ChoicePedal extends StatelessWidget {
  const _ChoicePedal({
    required this.choice,
    required this.label,
    required this.icon,
    required this.hint,
    required this.selected,
    required this.correct,
    required this.revealed,
    required this.locked,
    required this.onTap,
  });

  final ArenaChoice choice;
  final String label;
  final IconData icon;
  final String hint;
  final bool selected;
  final bool correct;
  final bool revealed;
  final bool locked;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;

    // Neutral until the reveal: both directions look equally plausible.
    Color accent = t.textPrimary;
    if (revealed) {
      if (correct) {
        accent = ArenaTone.primary.accent(t);
      } else if (selected) {
        accent = ArenaTone.danger.accent(t);
      } else {
        accent = t.border;
      }
    } else if (selected) {
      accent = t.textPrimary;
    }

    final filled = revealed ? (correct || selected) : selected;
    final fg = filled ? t.canvas : accent;

    return Semantics(
      button: true,
      enabled: !locked,
      selected: selected,
      label: '$label — $hint',
      child: GestureDetector(
        onTap: locked ? null : onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          height: 76,
          decoration: BoxDecoration(
            color: filled ? accent : Colors.transparent,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: accent, width: t.borderWidth + 0.8),
            boxShadow: [
              if (filled)
                BoxShadow(
                  color: accent.withValues(alpha: 0.35),
                  blurRadius: 18,
                  offset: const Offset(0, 4),
                ),
            ],
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 30, color: fg),
              const SizedBox(width: AppSpacing.sm),
              Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: AppTypography.actionPedal(color: fg)),
                  Text(
                    hint.toUpperCase(),
                    style: AppTypography.badge(
                      color: filled
                          ? fg.withValues(alpha: 0.75)
                          : t.textMuted,
                    ).copyWith(fontSize: 10),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SkipButton extends StatelessWidget {
  const _SkipButton({
    required this.locked,
    required this.selected,
    required this.onTap,
  });

  final bool locked;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = ArenaTone.caution.accent(t);
    return Semantics(
      button: true,
      enabled: !locked,
      label: 'Skip this round',
      child: GestureDetector(
        onTap: locked ? null : onTap,
        child: Container(
          height: 48,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected ? accent.withValues(alpha: 0.18) : Colors.transparent,
            borderRadius: BorderRadius.circular(AppRadius.full),
            border: Border.all(color: accent, width: t.borderWidth),
          ),
          child: Text('SKIP', style: AppTypography.skipButton(color: accent)),
        ),
      ),
    );
  }
}
