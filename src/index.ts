// Load the brand fonts by adding the links exported in ARENA_FONT_LINKS to your document head.
import "./design-system/theme/tokens.css";

export const ARENA_FONT_LINKS = [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;700&display=swap",
  },
] as const;


export { cn } from "./design-system/lib/cn";
export { Button } from "./design-system/components/Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./design-system/components/Button";
export { Badge } from "./design-system/components/Badge";
export type { BadgeProps, BadgeTone } from "./design-system/components/Badge";
export { Card, CardTitle, CardLabel } from "./design-system/components/Card";
export type { CardProps, CardVariant, CardTitleProps, CardLabelProps } from "./design-system/components/Card";
export { CodeInput } from "./design-system/components/CodeInput";
export type { CodeInputProps } from "./design-system/components/CodeInput";
export { ProgressBar } from "./design-system/components/ProgressBar";
export type { ProgressBarProps, ProgressTone } from "./design-system/components/ProgressBar";
export { ShotClock } from "./design-system/components/ShotClock";
export type { ShotClockProps } from "./design-system/components/ShotClock";
export { AnswerButton } from "./design-system/components/AnswerButton";
export type { AnswerButtonProps, AnswerChoice } from "./design-system/components/AnswerButton";
export { TopicTile } from "./design-system/components/TopicTile";
export type { TopicTileProps } from "./design-system/components/TopicTile";
export { ResultBanner } from "./design-system/components/ResultBanner";
export type { ResultBannerProps, ResultOutcome } from "./design-system/components/ResultBanner";
export { StatValue } from "./design-system/components/StatValue";
export type { StatValueProps, StatTone } from "./design-system/components/StatValue";
export { LeaderboardRow } from "./design-system/components/LeaderboardRow";
export type { LeaderboardRowProps } from "./design-system/components/LeaderboardRow";
export { NavBar } from "./design-system/components/NavBar";
export type { NavBarProps } from "./design-system/components/NavBar";
export { TabBar } from "./design-system/components/TabBar";
export type { TabBarProps, TabBarItem } from "./design-system/components/TabBar";
export { TierRow } from "./design-system/components/TierRow";
export type { TierRowProps, TierState } from "./design-system/components/TierRow";
