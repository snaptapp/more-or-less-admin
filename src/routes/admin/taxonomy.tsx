import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/taxonomy")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/facts", search: { view: "topics" } });
  },
});
