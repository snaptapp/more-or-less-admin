import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface LeaderboardRowProps extends HTMLAttributes<HTMLLIElement> {
  /** 1-based standing. */
  rank: number;
  /** Player display name. */
  name: string;
  /** Formatted score, e.g. "9.0k". */
  score: string;
}

/** One standing in a leaderboard list. Render inside a <ul>. */
export const LeaderboardRow = forwardRef<HTMLLIElement, LeaderboardRowProps>(
  ({ rank, name, score, className, ...props }, ref) => (
    <li ref={ref} className={cn("ds-leader", className)} {...props}>
      <span className={cn("ds-leader__rank", rank <= 3 && `ds-leader__rank--${rank}`)}>
        {rank}
      </span>
      <span className="ds-leader__name">{name}</span>
      <span className="ds-leader__score">{score}</span>
    </li>
  ),
);
LeaderboardRow.displayName = "LeaderboardRow";
