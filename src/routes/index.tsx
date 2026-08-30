import { createFileRoute } from "@tanstack/react-router";
import { Showcase } from "@/showcase/Showcase";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Arena DS — Tokens & Components" },
      {
        name: "description",
        content:
          "Showcase of the Arena design system: dark arcade tokens, buttons, cards, timers, and reward tracks.",
      },
      { property: "og:title", content: "Arena DS — Tokens & Components" },
      {
        property: "og:description",
        content: "Dark arcade game-show tokens and components, rendered live.",
      },
    ],
  }),
  component: Showcase,
});
