import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Badge } from "@/index";
import { OpsChatRail } from "@/admin/OpsChatRail";
import { chatFactsBank } from "@/lib/admin/ops.functions";
import type { ChatCard, ChatMessage, EditableRound } from "@/lib/admin/daily-blitz";

/**
 * Provides an operations chat interface for querying fact-bank coverage and managing crawl queues.
 *
 * @param onApplyPack - Callback for applying generated editable rounds and their optional topic.
 */
export function FactsBankChat({
  onApplyPack,
}: {
  onApplyPack?: (rounds: EditableRound[], topic?: string) => void;
}) {
  const chat = useServerFn(chatFactsBank);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const mutation = useMutation({
    mutationFn: (next: ChatMessage[]) =>
      chat({
        data: {
          messages: next.map(({ role, text }) => ({ role, text })),
        },
      }),
    onSuccess: (res, next) => {
      setMessages([
        ...next,
        {
          role: "assistant",
          text: res.text,
          cards: res.cards,
        },
      ]);
    },
  });

  const applyCard = (card: ChatCard) => {
    if (card.applyKind === "pack" && card.rounds?.length && onApplyPack) {
      onApplyPack(card.rounds, card.topic);
    }
  };

  return (
    <OpsChatRail
      subtitle="Coverage and enqueue only. Foundry writes fact_bank. Go drafts are Apply cards, not live Daily packs."
      emptyHint="Ask which genres are thin, enqueue a subject or playlist, or list the crawl queue."
      placeholder="e.g. Which Sports subjects have fewer than 3 facts? Enqueue NBA scoring."
      badge={<Badge tone="lime">Foundry verifies</Badge>}
      messages={messages}
      pending={mutation.isPending}
      error={mutation.error}
      onSend={(text) => {
        const next: ChatMessage[] = [...messages, { role: "user", text }];
        setMessages(next);
        mutation.mutate(next);
      }}
      onApplyCard={onApplyPack ? applyCard : undefined}
      applyLabel="Copy pack for Daily"
    />
  );
}
