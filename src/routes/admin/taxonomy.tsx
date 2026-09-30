import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/taxonomy")({
  head: () => ({ meta: [
    { title: "Topics — More or Less Admin" },
    { name: "description", content: "Manage More or Less topic taxonomy." },
    { property: "og:title", content: "Topics — More or Less Admin" },
    { property: "og:description", content: "Manage More or Less topic taxonomy." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  beforeLoad: () => {
    throw redirect({ to: "/admin/facts", search: { view: "topics" } });
  },
});
