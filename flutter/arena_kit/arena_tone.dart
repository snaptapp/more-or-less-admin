import 'package:flutter/material.dart';

import '../../core/theme/arcade_tokens.dart';

/// Semantic intent for every kit component. Colour is derived from the active
/// [ArcadeTokens] skin, never hardcoded, so in-game skinning keeps working.
///
/// Meaning is fixed:
/// * [primary]   volt — the main forward action / correct outcome
/// * [danger]    coral — failure, wrong answer, destructive action
/// * [featured]  purple — daily pack, premium, spotlight
/// * [caution]   amber — skip, warning, "are you sure"
/// * [streak]    orange — streaks and heat
/// * [neutral]   surface — quiet, secondary
enum ArenaTone { primary, danger, featured, caution, streak, neutral }

extension ArenaToneColors on ArenaTone {
  Color accent(ArcadeTokens t) => switch (this) {
        ArenaTone.primary => t.primaryVolt,
        ArenaTone.danger => t.accentCoral,
        ArenaTone.featured => t.secondaryPurple,
        ArenaTone.caution => t.amberSkip,
        ArenaTone.streak => t.streakOrange,
        ArenaTone.neutral => t.border,
      };

  /// Text/icon colour that sits on top of a filled [accent] surface.
  Color onAccent(ArcadeTokens t) => switch (this) {
        ArenaTone.neutral => t.textPrimary,
        ArenaTone.danger => t.textPrimary,
        _ => t.canvas,
      };

  /// Low-emphasis wash of the accent, for soft badges and card tints.
  Color wash(ArcadeTokens t) => accent(t).withValues(alpha: 0.14);
}
