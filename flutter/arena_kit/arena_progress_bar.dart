import 'package:flutter/material.dart';

import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_tone.dart';

/// Round progress / vault milestone track. Animates value changes and can
/// render segment ticks (5-round packs, milestone tiers).
class ArenaProgressBar extends StatelessWidget {
  const ArenaProgressBar({
    super.key,
    required this.value,
    this.tone = ArenaTone.primary,
    this.segments,
    this.height = 10,
    this.label,
    this.semanticLabel,
  }) : assert(value >= 0 && value <= 1);

  /// 0..1 completion.
  final double value;
  final ArenaTone tone;

  /// When set, draws dividers for this many equal segments.
  final int? segments;
  final double height;

  /// Optional mono caption rendered above the track (e.g. "ROUND 3 / 5").
  final String? label;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = tone.accent(t);

    return Semantics(
      label: semanticLabel ?? label,
      value: '${(value * 100).round()}%',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (label != null) ...[
            Text(
              label!.toUpperCase(),
              style: AppTypography.badge(color: t.textMuted)
                  .copyWith(fontSize: 11),
            ),
            const SizedBox(height: 6),
          ],
          LayoutBuilder(
            builder: (context, constraints) {
              final width = constraints.maxWidth;
              return Stack(
                children: [
                  Container(
                    height: height,
                    decoration: BoxDecoration(
                      color: t.surfaceDark,
                      borderRadius: BorderRadius.circular(height),
                      border: Border.all(color: t.border, width: 1),
                    ),
                  ),
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 320),
                    curve: Curves.easeOutCubic,
                    height: height,
                    width: width * value,
                    decoration: BoxDecoration(
                      color: accent,
                      borderRadius: BorderRadius.circular(height),
                      boxShadow: [
                        BoxShadow(
                          color: accent.withValues(alpha: 0.5),
                          blurRadius: 12,
                        ),
                      ],
                    ),
                  ),
                  if (segments != null && segments! > 1)
                    SizedBox(
                      height: height,
                      width: width,
                      child: Row(
                        children: List.generate(segments! - 1, (_) {
                          return Expanded(
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Container(width: 2, color: t.canvas),
                            ),
                          );
                        })
                          ..add(const Expanded(child: SizedBox.shrink())),
                      ),
                    ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}
