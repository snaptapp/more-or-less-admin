import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AdminAuthProvider } from "@/admin/auth";
import { AdminShell } from "@/admin/AdminShell";

export const Route = createFileRoute("/admin")({
  ssr: false,
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
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <AdminAuthProvider>
      <AdminShell>
        <Outlet />
      </AdminShell>
    </AdminAuthProvider>
  );
}
