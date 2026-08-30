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
    ],
  }),
  component: () => null,
});
