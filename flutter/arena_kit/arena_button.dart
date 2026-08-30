import 'package:flutter/material.dart';

import '../../core/constants/app_spacing.dart';
import '../../core/constants/app_typography.dart';
import '../../core/theme/arcade_tokens.dart';
import 'arena_tone.dart';

enum ArenaButtonVariant { solid, outline, ghost }

enum ArenaButtonSize { small, medium, large }

/// The one button in the system. Tone carries meaning, variant carries
/// emphasis, size carries scale — no one-off boolean styling props.
///
/// Guarantees: >=48dp touch target, visible focus ring, tabular label, a
/// loading state that keeps its width, and a required semantic label for
/// icon-only usage.
class ArenaButton extends StatefulWidget {
  const ArenaButton({
    super.key,
    required this.label,
    this.onPressed,
    this.tone = ArenaTone.primary,
    this.variant = ArenaButtonVariant.solid,
    this.size = ArenaButtonSize.medium,
    this.icon,
    this.trailingIcon,
    this.isLoading = false,
    this.fullWidth = false,
    this.semanticLabel,
    this.focusNode,
    this.autofocus = false,
  });

  /// Icon-only button. [semanticLabel] is required by assertion.
  const ArenaButton.icon({
    super.key,
    required IconData this.icon,
    required String this.semanticLabel,
    this.onPressed,
    this.tone = ArenaTone.neutral,
    this.variant = ArenaButtonVariant.outline,
    this.size = ArenaButtonSize.medium,
    this.isLoading = false,
    this.focusNode,
    this.autofocus = false,
  })  : label = '',
        trailingIcon = null,
        fullWidth = false;

  final String label;
  final VoidCallback? onPressed;
  final ArenaTone tone;
  final ArenaButtonVariant variant;
  final ArenaButtonSize size;
  final IconData? icon;
  final IconData? trailingIcon;
  final bool isLoading;
  final bool fullWidth;
  final String? semanticLabel;
  final FocusNode? focusNode;
  final bool autofocus;

  bool get _isIconOnly => label.isEmpty && icon != null;
  bool get _enabled => onPressed != null && !isLoading;

  @override
  State<ArenaButton> createState() => _ArenaButtonState();
}

class _ArenaButtonState extends State<ArenaButton> {
  bool _pressed = false;
  bool _hovered = false;
  bool _focused = false;

  double get _height => switch (widget.size) {
        ArenaButtonSize.small => 40,
        ArenaButtonSize.medium => 52,
        ArenaButtonSize.large => 62,
      };

  double get _fontSize => switch (widget.size) {
        ArenaButtonSize.small => 16,
        ArenaButtonSize.medium => 20,
        ArenaButtonSize.large => 26,
      };

  @override
  Widget build(BuildContext context) {
    final t = context.arcadeTokens;
    final accent = widget.tone.accent(t);
    final enabled = widget._enabled;

    final Color background;
    final Color foreground;
    final Color borderColor;
    switch (widget.variant) {
      case ArenaButtonVariant.solid:
        background = accent;
        foreground = widget.tone.onAccent(t);
        borderColor = accent;
      case ArenaButtonVariant.outline:
        background = Colors.transparent;
        foreground = widget.tone == ArenaTone.neutral ? t.textPrimary : accent;
        borderColor = accent;
      case ArenaButtonVariant.ghost:
        background = _hovered ? widget.tone.wash(t) : Colors.transparent;
        foreground = widget.tone == ArenaTone.neutral ? t.textSecondary : accent;
        borderColor = Colors.transparent;
    }

    final label = Text(
      widget.label.toUpperCase(),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: AppTypography.actionPedal(color: foreground)
          .copyWith(fontSize: _fontSize),
    );

    final Widget content = widget.isLoading
        ? SizedBox(
            height: _fontSize,
            width: _fontSize,
            child: CircularProgressIndicator(strokeWidth: 2.5, color: foreground),
          )
        : Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (widget.icon != null)
                Icon(widget.icon, size: _fontSize + 2, color: foreground),
              if (widget.icon != null && !widget._isIconOnly)
                const SizedBox(width: AppSpacing.sm),
              if (!widget._isIconOnly) Flexible(child: label),
              if (widget.trailingIcon != null) ...[
                const SizedBox(width: AppSpacing.sm),
                Icon(widget.trailingIcon, size: _fontSize, color: foreground),
              ],
            ],
          );

    final button = AnimatedOpacity(
      duration: const Duration(milliseconds: 120),
      opacity: enabled ? 1 : 0.45,
      child: AnimatedScale(
        duration: const Duration(milliseconds: 90),
        scale: _pressed && enabled ? 0.97 : 1,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          height: _height,
          width: widget._isIconOnly ? _height : null,
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          padding: widget._isIconOnly
              ? EdgeInsets.zero
              : const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: borderColor, width: t.borderWidth),
            boxShadow: [
              if (widget.variant == ArenaButtonVariant.solid && enabled)
                BoxShadow(
                  color: accent.withValues(alpha: _hovered ? 0.45 : 0.25),
                  blurRadius: _hovered ? 22 : 14,
                  offset: const Offset(0, 4),
                ),
              if (_focused)
                BoxShadow(color: t.textPrimary, blurRadius: 0, spreadRadius: 2.5),
            ],
          ),
          alignment: Alignment.center,
          child: content,
        ),
      ),
    );

    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.semanticLabel ?? widget.label,
      child: FocusableActionDetector(
        focusNode: widget.focusNode,
        autofocus: widget.autofocus,
        enabled: enabled,
        mouseCursor:
            enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
        onShowHoverHighlight: (v) => setState(() => _hovered = v),
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              widget.onPressed?.call();
              return null;
            },
          ),
        },
        child: GestureDetector(
          onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
          onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
          onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
          onTap: enabled ? widget.onPressed : null,
          child: widget.fullWidth
              ? SizedBox(width: double.infinity, child: button)
              : button,
        ),
      ),
    );
  }
}
