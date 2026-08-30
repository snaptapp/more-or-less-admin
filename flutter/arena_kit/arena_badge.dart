import 'package:flutter/material.dart';

import '../../core/constants/app_spacing.dart';
import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_tone.dart';

enum ArenaBadgeVariant { soft, solid, outline }

/// Compact mono status chip: streak counts, difficulty, "AFTER DARK",
/// "DISPUTED", pack category. Always pairs colour with a text label so the
/// state never depends on colour alone.
class ArenaBadge extends StatelessWidget {
  const ArenaBadge({
    super.key,
    required this.label,
    this.tone = ArenaTone.neutral,
    this.variant = ArenaBadgeVariant.soft,
    this.icon,
    this.dense = false,
  });

  final String label;
  final ArenaTone tone;
  final ArenaBadgeVariant variant;
  final IconData? icon;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = tone.accent(t);

    final (Color bg, Color fg, Color border) = switch (variant) {
      ArenaBadgeVariant.soft => (tone.wash(t), accent, Colors.transparent),
      ArenaBadgeVariant.solid => (accent, tone.onAccent(t), accent),
      ArenaBadgeVariant.outline => (Colors.transparent, accent, accent),
    };

    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: dense ? AppSpacing.sm : AppSpacing.md - 4,
        vertical: dense ? 3 : 6,
      ),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(AppRadius.full),
        border: Border.all(color: border, width: t.borderWidth),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: dense ? 12 : 14, color: fg),
            const SizedBox(width: 5),
          ],
          Text(
            label.toUpperCase(),
            style: AppTypography.badge(color: fg)
                .copyWith(fontSize: dense ? 11 : 13),
          ),
        ],
      ),
    );
  }
}
