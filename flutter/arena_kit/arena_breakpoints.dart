import 'package:flutter/widgets.dart';

/// Canonical responsive breakpoints for More or Less.
///
/// Mobile is the primary layout; tablet and desktop widen the content column
/// rather than re-flowing into a different information architecture.
enum ArenaSize { mobile, tablet, desktop }

class ArenaBreakpoints {
  ArenaBreakpoints._();

  static const double tablet = 720;
  static const double desktop = 1180;

  /// Content never spans the full width of a widescreen display.
  static const double maxContentWidthMobile = 560;
  static const double maxContentWidthTablet = 720;
  static const double maxContentWidthDesktop = 960;
}

class ArenaLayout {
  const ArenaLayout(this.size, this.width);

  final ArenaSize size;
  final double width;

  factory ArenaLayout.of(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    if (w >= ArenaBreakpoints.desktop) return ArenaLayout(ArenaSize.desktop, w);
    if (w >= ArenaBreakpoints.tablet) return ArenaLayout(ArenaSize.tablet, w);
    return ArenaLayout(ArenaSize.mobile, w);
  }

  bool get isMobile => size == ArenaSize.mobile;
  bool get isTablet => size == ArenaSize.tablet;
  bool get isDesktop => size == ArenaSize.desktop;
  bool get isWide => size != ArenaSize.mobile;

  double get maxContentWidth => switch (size) {
        ArenaSize.mobile => ArenaBreakpoints.maxContentWidthMobile,
        ArenaSize.tablet => ArenaBreakpoints.maxContentWidthTablet,
        ArenaSize.desktop => ArenaBreakpoints.maxContentWidthDesktop,
      };

  double get gutter => switch (size) {
        ArenaSize.mobile => 16,
        ArenaSize.tablet => 24,
        ArenaSize.desktop => 32,
      };

  /// Pick a value per breakpoint, falling back down the ladder.
  T pick<T>({required T mobile, T? tablet, T? desktop}) => switch (size) {
        ArenaSize.mobile => mobile,
        ArenaSize.tablet => tablet ?? mobile,
        ArenaSize.desktop => desktop ?? tablet ?? mobile,
      };
}

/// Centers and width-caps page content so widescreen never stretches text
/// lines or action rows past a comfortable measure.
class ArenaContentColumn extends StatelessWidget {
  const ArenaContentColumn({
    super.key,
    required this.child,
    this.maxWidth,
    this.padding,
  });

  final Widget child;
  final double? maxWidth;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final layout = ArenaLayout.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth ?? layout.maxContentWidth),
        child: Padding(
          padding: padding ?? EdgeInsets.symmetric(horizontal: layout.gutter),
          child: child,
        ),
      ),
    );
  }
}
