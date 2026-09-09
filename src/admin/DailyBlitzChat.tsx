import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge } from "@/index";
import { OpsChatRail } from "@/admin/OpsChatRail";
import { chatDailyBlitz } from "@/lib/admin/ops.functions";
import type { ChatCard, ChatMessage, EditableRound } from "@/lib/admin/daily-blitz";

/**
 * Provides a date-specific chat interface for planning and applying daily blitz rounds.
 *
 * @param date - The date associated with the active conversation and round plan
 * @param topic - The current planning topic
 * @param brief - The planning brief supplied to the chat
 * @param rounds - The editable rounds currently in the plan
 * @param unfilledDates - Dates that still have unfilled rounds
 * @param onApplyPack - Handles applying a complete pack returned by the chat
 * @param onApplyRound - Handles applying an individual round returned by the chat
 */
export function DailyBlitzChat({
  date,
  topic,
  brief,
  rounds,
  unfilledDates,
  onApplyPack,
  onApplyRound,
}: {
  date: string;
  topic: string;
  brief: string;
  rounds: EditableRound[];
  unfilledDates: string[];
  onApplyPack: (rounds: EditableRound[], topic?: string) => void;
  onApplyRound: (index: number, round: EditableRound) => void;
}) {
  const chat = useServerFn(chatDailyBlitz);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const messages = threads[date] ?? [];

  const mutation = useMutation({
    mutationFn: (vars: {
      date: string;
      topic: string;
      brief: string;
      rounds: EditableRound[];
      unfilledDates: string[];
      next: ChatMessage[];
    }) =>
      chat({
        data: {
          date: vars.date,
          topic: vars.topic,
          brief: vars.brief,
          rounds: vars.rounds,
          unfilledDates: vars.unfilledDates,
          messages: vars.next.map(({ role, text }) => ({ role, text })),
        },
      }),
    onSuccess: (res, vars) => {
      setThreads((prev) => ({
        ...prev,
        [vars.date]: [
          ...vars.next,
          {
            role: "assistant",
            text: res.text,
            cards: res.cards,
          },
        ],
      }));
    },
  });

  const applyCard = (card: ChatCard) => {
    if (card.applyKind === "pack" && card.rounds?.length) {
      onApplyPack(card.rounds, card.topic);
      return;
    }
    if (card.applyKind === "round" && card.round) {
      const index = card.roundIndex ?? Math.max(0, (card.round.round_number || 1) - 1);
      onApplyRound(index, card.round);
    }
  };

  return (
    <OpsChatRail
      key={date}
      subtitle={`Gemini plans. Go writes packs. You click Apply, then Save. Thread for ${date}.`}
      emptyHint="Ask for a 15-round Sports mix, a swap, or which of the next two weeks are still on the Sports bank cycle."
      placeholder="e.g. Draft a 15-round NBA mix, avoid Super Bowl, then flag empty dates."
      badge={
        <Badge tone={unfilledDates.length ? "amber" : "lime"}>
          {unfilledDates.length ? `${unfilledDates.length} unfilled` : "Strip filled"}
        </Badge>
      }
      messages={messages}
      pending={mutation.isPending}
      error={mutation.error}
      onSend={(text) => {
        const next: ChatMessage[] = [...messages, { role: "user", text }];
        setThreads((prev) => ({ ...prev, [date]: next }));
        mutation.mutate({ date, topic, brief, rounds, unfilledDates, next });
      }}
      onApplyCard={applyCard}
    />
  );
}
