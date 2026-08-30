import 'package:flutter/material.dart';

import '../../core/constants/app_spacing.dart';
import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_button.dart';
import 'arena_tone.dart';

/// One empty/zero state for versus, profile, store and vault — replaces the
/// four bespoke empty widgets that each had their own spacing and type.
class ArenaEmptyState extends StatelessWidget {
  const ArenaEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.tone = ArenaTone.neutral,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String message;
  final ArenaTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = tone.accent(t);

    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.lg,
        vertical: AppSpacing.xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            height: 72,
            width: 72,
            decoration: BoxDecoration(
              color: tone.wash(t),
              shape: BoxShape.circle,
              border: Border.all(color: accent, width: t.borderWidth),
            ),
            child: Icon(icon, size: 32, color: accent),
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            title,
            textAlign: TextAlign.center,
            style: AppTypography.screenHeader(color: t.textPrimary)
                .copyWith(fontSize: 26),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            message,
            textAlign: TextAlign.center,
            style: AppTypography.explanation(color: t.textSecondary),
          ),
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: AppSpacing.lg),
            ArenaButton(
              label: actionLabel!,
              onPressed: onAction,
              tone: tone == ArenaTone.neutral ? ArenaTone.primary : tone,
            ),
          ],
        ],
      ),
    );
  }
}
