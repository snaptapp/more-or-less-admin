import { createFileRoute } from "@tanstack/react-router";
import { Showcase } from "@/preview/Showcase";

export const Route = createFileRoute("/design-system")({
  head: () => ({
    meta: [
      { title: "Arena Design System — More or Less" },
      {
        name: "description",
        content: "Tokens and components for the More or Less arcade game-show interface.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Showcase,
});
