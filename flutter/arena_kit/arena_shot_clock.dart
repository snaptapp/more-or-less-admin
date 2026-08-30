import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_tone.dart';

/// Circular shot clock. Tone escalates primary -> caution -> danger as time
/// drains, and the remaining seconds are always announced as text so the
/// urgency is never conveyed by colour alone.
class ArenaShotClock extends StatelessWidget {
  const ArenaShotClock({
    super.key,
    required this.remaining,
    required this.total,
    this.size = 72,
    this.paused = false,
  })  : assert(total > Duration.zero);

  final Duration remaining;
  final Duration total;
  final double size;
  final bool paused;

  double get _fraction =>
      (remaining.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);

  ArenaTone get tone {
    if (_fraction <= 0.2) return ArenaTone.danger;
    if (_fraction <= 0.45) return ArenaTone.caution;
    return ArenaTone.primary;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = tone.accent(t);
    final seconds = (remaining.inMilliseconds / 1000).ceil();

    return Semantics(
      liveRegion: true,
      label: paused ? 'Timer paused' : '$seconds seconds left',
      child: SizedBox(
        height: size,
        width: size,
        child: Stack(
          alignment: Alignment.center,
          children: [
            CustomPaint(
              size: Size.square(size),
              painter: _ClockPainter(
                fraction: _fraction,
                track: t.surfaceDark,
                accent: accent,
                stroke: size * 0.09,
              ),
            ),
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '$seconds',
                  style: AppTypography.shotClock(color: accent)
                      .copyWith(fontSize: size * 0.4),
                ),
                Text(
                  paused ? 'HELD' : 'SEC',
                  style: AppTypography.badge(color: t.textMuted)
                      .copyWith(fontSize: size * 0.13),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ClockPainter extends CustomPainter {
  _ClockPainter({
    required this.fraction,
    required this.track,
    required this.accent,
    required this.stroke,
  });

  final double fraction;
  final Color track;
  final Color accent;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    final center = rect.center;
    final radius = (size.width - stroke) / 2;

    final basePaint = Paint()
      ..color = track
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke;
    canvas.drawCircle(center, radius, basePaint);

    final arcPaint = Paint()
      ..color = accent
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = stroke
      ..maskFilter = const MaskFilter.blur(BlurStyle.solid, 2);

    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      2 * math.pi * fraction,
      false,
      arcPaint,
    );
  }

  @override
  bool shouldRepaint(_ClockPainter old) =>
      old.fraction != fraction || old.accent != accent;
}
