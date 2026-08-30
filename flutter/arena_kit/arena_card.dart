import 'package:flutter/material.dart';

import '../../core/constants/app_spacing.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_tone.dart';

enum ArenaCardEmphasis {
  /// Quiet container: surface + hairline border.
  plain,

  /// Tinted wash + accent border, for the daily pack / featured slot.
  accent,

  /// Accent left rail only — good for list rows and status items.
  rail,
}

/// Single card surface for the whole app: one radius, one border treatment,
/// one press animation. Replaces the per-screen Container/BoxDecoration
/// copies that had drifted apart between lobby, vault and daily screens.
class ArenaCard extends StatefulWidget {
  const ArenaCard({
    super.key,
    required this.child,
    this.onTap,
    this.tone = ArenaTone.neutral,
    this.emphasis = ArenaCardEmphasis.plain,
    this.padding = const EdgeInsets.all(AppSpacing.md),
    this.selected = false,
    this.semanticLabel,
  });

  final Widget child;
  final VoidCallback? onTap;
  final ArenaTone tone;
  final ArenaCardEmphasis emphasis;
  final EdgeInsetsGeometry padding;
  final bool selected;
  final String? semanticLabel;

  @override
  State<ArenaCard> createState() => _ArenaCardState();
}

class _ArenaCardState extends State<ArenaCard> {
  bool _pressed = false;
  bool _hovered = false;
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = widget.tone.accent(t);
    final interactive = widget.onTap != null;
    final highlighted = widget.selected || _focused;

    final decoration = BoxDecoration(
      color: widget.emphasis == ArenaCardEmphasis.accent
          ? Color.alphaBlend(widget.tone.wash(t), t.surfaceCard)
          : t.surfaceCard,
      borderRadius: BorderRadius.circular(18),
      border: Border.all(
        color: switch (widget.emphasis) {
          ArenaCardEmphasis.accent => accent,
          _ => highlighted ? accent : t.border,
        },
        width: highlighted ? t.borderWidth + 0.8 : t.borderWidth,
      ),
      boxShadow: [
        if (_hovered && interactive)
          BoxShadow(
            color: accent.withValues(alpha: 0.22),
            blurRadius: 20,
            offset: const Offset(0, 6),
          ),
      ],
    );

    Widget body = Padding(padding: widget.padding, child: widget.child);
    if (widget.emphasis == ArenaCardEmphasis.rail) {
      body = Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: 4,
            decoration: BoxDecoration(
              color: accent,
              borderRadius: const BorderRadius.horizontal(
                left: Radius.circular(18),
              ),
            ),
          ),
          Expanded(child: body),
        ],
      );
    }

    final card = AnimatedScale(
      duration: const Duration(milliseconds: 90),
      scale: _pressed ? 0.985 : 1,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        decoration: decoration,
        clipBehavior: Clip.antiAlias,
        child: body,
      ),
    );

    if (!interactive) return Semantics(label: widget.semanticLabel, child: card);

    return Semantics(
      button: true,
      selected: widget.selected,
      label: widget.semanticLabel,
      child: FocusableActionDetector(
        mouseCursor: SystemMouseCursors.click,
        onShowHoverHighlight: (v) => setState(() => _hovered = v),
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              widget.onTap?.call();
              return null;
            },
          ),
        },
        child: GestureDetector(
          onTapDown: (_) => setState(() => _pressed = true),
          onTapUp: (_) => setState(() => _pressed = false),
          onTapCancel: () => setState(() => _pressed = false),
          onTap: widget.onTap,
          child: card,
        ),
      ),
    );
  }
}
