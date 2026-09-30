import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin" });
  },
  head: () => ({
    meta: [
      { title: "More or Less — Admin Portal" },
      {
        name: "description",
        content: "Internal operations console for the More or Less trivia game.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "More or Less — Admin Portal" },
      { property: "og:description", content: "Internal operations console for the More or Less trivia game." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => null,
});
