import 'package:flutter/material.dart';

import '../../core/constants/app_spacing.dart';
import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_card.dart';
import 'arena_tone.dart';

/// Big number + mono caption. Used on profile, post-game summary and the
/// vault. Value is rendered with tabular figures so counters don't jitter.
class ArenaStatTile extends StatelessWidget {
  const ArenaStatTile({
    super.key,
    required this.value,
    required this.label,
    this.tone = ArenaTone.primary,
    this.caption,
    this.icon,
    this.compact = false,
    this.onTap,
  });

  final String value;
  final String label;
  final ArenaTone tone;
  final String? caption;
  final IconData? icon;
  final bool compact;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = tone.accent(t);

    return ArenaCard(
      onTap: onTap,
      tone: tone,
      padding: EdgeInsets.all(compact ? AppSpacing.md - 4 : AppSpacing.md),
      semanticLabel: '$label: $value',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (icon != null) ...[
                Icon(icon, size: 15, color: accent),
                const SizedBox(width: 6),
              ],
              Expanded(
                child: Text(
                  label.toUpperCase(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.badge(color: t.textMuted)
                      .copyWith(fontSize: 11),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: AppTypography.statHero(color: accent)
                  .copyWith(fontSize: compact ? 40 : 56),
            ),
          ),
          if (caption != null) ...[
            const SizedBox(height: 4),
            Text(
              caption!,
              style: AppTypography.explanation(color: t.textSecondary)
                  .copyWith(fontSize: 13),
            ),
          ],
        ],
      ),
    );
  }
}
