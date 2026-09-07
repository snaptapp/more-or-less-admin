import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useMemo, useState } from "react";
import { Badge, Button, Card, CardLabel, CardTitle } from "@/index";
import { ErrorNote, InlineEditorRow, statusTone } from "@/admin/AdminShell";
import { GENRES, familiesForGenre } from "@/lib/admin/taxonomy";
import {
  createPlaylistAction,
  createTopic,
  fetchCrawlQueue,
  fetchPlaylists,
  fetchSubjects,
  queueCrawl,
  savePlaylist,
  saveSubject,
  triggerCrawlAction,
  updateCrawlPriority,
} from "@/lib/admin/ops.functions";

type Subject = Awaited<ReturnType<typeof fetchSubjects>>["subjects"][number];
type Playlist = Awaited<ReturnType<typeof fetchPlaylists>>[number];

function observedFamilies(subjects: Subject[], genre: string): string[] {
  return subjects.filter((s) => s.category === genre).map((s) => s.sub_category);
}

function TopicEditor({
  subject,
  playlists,
  subjects,
  onDone,
}: {
  subject: Subject;
  playlists: Playlist[];
  subjects: Subject[];
  onDone: () => void;
}) {
  const save = useServerFn(saveSubject);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    category: subject.category,
    sub_category: subject.sub_category,
    aliases: subject.aliases.join(", "),
    crawl_notes: subject.crawl_notes,
    playlist_ids: subject.playlist_ids,
  });

  const familyOptions = familiesForGenre(form.category, observedFamilies(subjects, form.category));

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id: subject.id,
          category: form.category,
          sub_category: form.sub_category,
          aliases: form.aliases.split(",").map((v) => v.trim()).filter(Boolean),
          crawl_notes: form.crawl_notes,
          playlist_ids: form.playlist_ids,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["subjects"] });
      await queryClient.invalidateQueries({ queryKey: ["playlists"] });
      onDone();
    },
  });

  function togglePlaylist(id: string) {
    setForm((current) => ({
      ...current,
      playlist_ids: current.playlist_ids.includes(id)
        ? current.playlist_ids.filter((item) => item !== id)
        : [...current.playlist_ids, id],
    }));
  }

  return (
    <Card>
      <CardTitle>{subject.subject}</CardTitle>
      <div className="admin-grid" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field">
          <span>Genre</span>
          <select
            className="admin-select"
            value={form.category}
            onChange={(e) =>
              setForm({
                ...form,
                category: e.target.value,
                sub_category: e.target.value === form.category ? form.sub_category : "",
              })
            }
          >
            <option value="">—</option>
            {GENRES.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>Family</span>
          <select
            className="admin-select"
            value={form.sub_category}
            onChange={(e) => setForm({ ...form, sub_category: e.target.value })}
          >
            <option value="">Needs family</option>
            {familyOptions.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="admin-field" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <span>New family name</span>
        <input
          className="admin-input"
          placeholder="Type to add a family under this genre"
          onBlur={(e) => {
            const value = e.target.value.trim();
            if (value) {
              setForm({ ...form, sub_category: value });
              e.target.value = "";
            }
          }}
        />
      </label>
      <label className="admin-field" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <span>Aliases (comma separated)</span>
        <input
          className="admin-input"
          value={form.aliases}
          onChange={(e) => setForm({ ...form, aliases: e.target.value })}
        />
      </label>
      <div className="admin-field" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <span>Playlists (optional, many)</span>
        {playlists.length === 0 ? (
          <p className="admin-empty" style={{ margin: 0 }}>
            No playlists yet. Create one in the Playlists tab.
          </p>
        ) : (
          <div className="admin-chip-list">
            {playlists.map((playlist) => (
              <label key={playlist.id} className="admin-check-chip">
                <input
                  type="checkbox"
                  checked={form.playlist_ids.includes(playlist.id)}
                  onChange={() => togglePlaylist(playlist.id)}
                />
                {playlist.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <label className="admin-field" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <span>Crawl notes</span>
        <textarea
          className="admin-textarea"
          value={form.crawl_notes}
          onChange={(e) => setForm({ ...form, crawl_notes: e.target.value })}
        />
      </label>
      <ErrorNote error={mutation.error} />
      <div className="admin-row-actions" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          Save topic
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </Card>
  );
}

function NewTopicForm({
  subjects,
  onDone,
}: {
  subjects: Subject[];
  onDone: () => void;
}) {
  const create = useServerFn(createTopic);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    subject: "",
    category: "Animals & Nature",
    sub_category: "",
    aliases: "",
    playlist_ids: [] as string[],
  });
  const familyOptions = familiesForGenre(form.category, observedFamilies(subjects, form.category));

  const mutation = useMutation({
    mutationFn: () =>
      create({
        data: {
          subject: form.subject.trim(),
          category: form.category,
          sub_category: form.sub_category || undefined,
          aliases: form.aliases.split(",").map((v) => v.trim()).filter(Boolean),
          playlist_ids: form.playlist_ids,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["subjects"] });
      await queryClient.invalidateQueries({ queryKey: ["playlists"] });
      onDone();
    },
  });

  return (
    <Card>
      <CardTitle>New topic</CardTitle>
      <div className="admin-grid" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field">
          <span>Topic</span>
          <input
            className="admin-input"
            placeholder="e.g. Cheetahs"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Genre</span>
          <select
            className="admin-select"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value, sub_category: "" })}
          >
            {GENRES.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>Family</span>
          <select
            className="admin-select"
            value={form.sub_category}
            onChange={(e) => setForm({ ...form, sub_category: e.target.value })}
          >
            <option value="">Needs family</option>
            {familyOptions.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorNote error={mutation.error} />
      <div className="admin-row-actions" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <Button disabled={!form.subject.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          Create topic
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function TopicsPanel() {
  const list = useServerFn(fetchSubjects);
  const listPlaylistsFn = useServerFn(fetchPlaylists);
  const [filters, setFilters] = useState({ search: "", category: "", family: "", playlistId: "" });
  const [selected, setSelected] = useState<Subject | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ["subjects", filters],
    queryFn: () =>
      list({
        data: {
          search: filters.search || undefined,
          category: filters.category || undefined,
          family: filters.family || undefined,
          playlistId: filters.playlistId || undefined,
        },
      }),
    retry: false,
  });

  const playlistsQuery = useQuery({
    queryKey: ["playlists"],
    queryFn: () => listPlaylistsFn(),
    retry: false,
  });

  const familyOptions = familiesForGenre(
    filters.category,
    (query.data?.subjects ?? []).map((s) => s.sub_category),
  );
  const playlists = playlistsQuery.data ?? [];

  return (
    <>
      <div className="admin-grid">
        {query.data?.coverage.map((entry) => (
          <Card key={entry.category}>
            <CardLabel>{entry.category || "Uncategorised"}</CardLabel>
            <p className="admin-stat">{entry.facts}</p>
            <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13, margin: 0 }}>
              {entry.subjects} topics
            </p>
          </Card>
        ))}
      </div>

      <div className="admin-toolbar">
        <label className="admin-field" style={{ flex: "1 1 240px" }}>
          <span>Search topic or alias</span>
          <input
            className="admin-input"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Genre</span>
          <select
            className="admin-select"
            value={filters.category}
            onChange={(e) => setFilters({ ...filters, category: e.target.value, family: "" })}
          >
            <option value="">All</option>
            {GENRES.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>Family</span>
          <select
            className="admin-select"
            value={filters.family}
            onChange={(e) => setFilters({ ...filters, family: e.target.value })}
          >
            <option value="">All</option>
            {familyOptions.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </label>
        <label className="admin-field">
          <span>Playlist</span>
          <select
            className="admin-select"
            value={filters.playlistId}
            onChange={(e) => setFilters({ ...filters, playlistId: e.target.value })}
          >
            <option value="">All</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={() => {
            setCreating((v) => !v);
            setSelected(null);
          }}
        >
          {creating ? "Close" : "New topic"}
        </Button>
      </div>

      <ErrorNote error={query.error ?? playlistsQuery.error} />
      {creating ? (
        <NewTopicForm
          subjects={query.data?.subjects ?? []}
          onDone={() => setCreating(false)}
        />
      ) : null}

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Genre</th>
              <th>Family</th>
              <th>Topic</th>
              <th>Playlists</th>
              <th>Aliases</th>
              <th>Facts</th>
              <th>Last crawled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.subjects.map((subject) => {
              const isEditing = selected?.id === subject.id;
              const playlistNames = subject.playlist_ids
                .map((id) => playlists.find((p) => p.id === id)?.name)
                .filter(Boolean);
              return (
                <Fragment key={subject.id}>
                  <tr className={isEditing ? "is-editing" : undefined}>
                    <td>{subject.category || "—"}</td>
                    <td>{subject.sub_category || "Needs family"}</td>
                    <td>
                      <strong>{subject.subject}</strong>
                    </td>
                    <td>{playlistNames.join(", ") || "—"}</td>
                    <td>{subject.aliases.join(", ") || "—"}</td>
                    <td>{subject.fact_count}</td>
                    <td>{subject.last_crawled_at ?? "—"}</td>
                    <td>
                      <Button
                        size="sm"
                        variant={isEditing ? "primary" : "ghost"}
                        onClick={() => setSelected(isEditing ? null : subject)}
                      >
                        {isEditing ? "Close" : "Edit"}
                      </Button>
                    </td>
                  </tr>
                  {isEditing ? (
                    <InlineEditorRow colSpan={8}>
                      <TopicEditor
                        subject={subject}
                        playlists={playlists}
                        subjects={query.data.subjects}
                        onDone={() => setSelected(null)}
                      />
                    </InlineEditorRow>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading topics…</p> : null}
      </div>
    </>
  );
}

function PlaylistEditor({
  playlist,
  subjects,
  onDone,
}: {
  playlist: Playlist;
  subjects: Subject[];
  onDone: () => void;
}) {
  const save = useServerFn(savePlaylist);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: playlist.name,
    aliases: playlist.aliases.join(", "),
    topic_keys: playlist.topic_keys,
    search: "",
  });

  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id: playlist.id,
          name: form.name,
          aliases: form.aliases.split(",").map((v) => v.trim()).filter(Boolean),
          topic_keys: form.topic_keys,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["playlists"] });
      await queryClient.invalidateQueries({ queryKey: ["subjects"] });
      onDone();
    },
  });

  const visibleTopics = useMemo(() => {
    const term = form.search.trim().toLowerCase();
    if (!term) return subjects;
    return subjects.filter((s) => s.subject.toLowerCase().includes(term) || s.category.toLowerCase().includes(term));
  }, [form.search, subjects]);

  function toggleTopic(id: string) {
    setForm((current) => ({
      ...current,
      topic_keys: current.topic_keys.includes(id)
        ? current.topic_keys.filter((key) => key !== id)
        : [...current.topic_keys, id],
    }));
  }

  return (
    <Card>
      <CardTitle>{playlist.name}</CardTitle>
      <div className="admin-grid" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field">
          <span>Name</span>
          <input
            className="admin-input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Aliases (comma separated)</span>
          <input
            className="admin-input"
            value={form.aliases}
            onChange={(e) => setForm({ ...form, aliases: e.target.value })}
          />
        </label>
      </div>
      <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
        Topics can belong to many playlists. Playlists may mix genres. {form.topic_keys.length} selected.
      </p>
      <label className="admin-field">
        <span>Filter topics</span>
        <input
          className="admin-input"
          value={form.search}
          onChange={(e) => setForm({ ...form, search: e.target.value })}
        />
      </label>
      <div className="admin-chip-list" style={{ marginTop: "var(--ds-arena-space-3)", maxHeight: 240, overflow: "auto" }}>
        {visibleTopics.map((subject) => (
          <label key={subject.id} className="admin-check-chip">
            <input
              type="checkbox"
              checked={form.topic_keys.includes(subject.id)}
              onChange={() => toggleTopic(subject.id)}
            />
            {subject.subject}
            <span className="admin-check-chip-meta">
              {subject.category || "—"}
              {subject.sub_category ? ` › ${subject.sub_category}` : ""}
            </span>
          </label>
        ))}
      </div>
      <ErrorNote error={mutation.error} />
      <div className="admin-row-actions" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          Save playlist
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    </Card>
  );
}

export function PlaylistsPanel() {
  const list = useServerFn(fetchPlaylists);
  const listSubjectsFn = useServerFn(fetchSubjects);
  const create = useServerFn(createPlaylistAction);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [draftName, setDraftName] = useState("");

  const query = useQuery({
    queryKey: ["playlists"],
    queryFn: () => list(),
    retry: false,
  });
  const subjectsQuery = useQuery({
    queryKey: ["subjects", "playlist-members"],
    queryFn: () => listSubjectsFn({ data: {} }),
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: () => create({ data: { name: draftName.trim() } }),
    onSuccess: async () => {
      setDraftName("");
      await queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
  });

  const subjects = subjectsQuery.data?.subjects ?? [];

  return (
    <>
      <div className="admin-toolbar">
        <label className="admin-field" style={{ flex: "1 1 240px" }}>
          <span>New playlist</span>
          <input
            className="admin-input"
            placeholder="e.g. Apex Predators"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
          />
        </label>
        <Button disabled={!draftName.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
          Create playlist
        </Button>
      </div>
      <ErrorNote error={query.error ?? createMutation.error ?? subjectsQuery.error} />

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Playlist</th>
              <th>Topics</th>
              <th>Aliases</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.map((playlist) => {
              const isEditing = selected?.id === playlist.id;
              const memberNames = playlist.topic_keys
                .map((key) => subjects.find((s) => s.id === key)?.subject ?? key)
                .join(", ");
              return (
                <Fragment key={playlist.id}>
                  <tr className={isEditing ? "is-editing" : undefined}>
                    <td>
                      <strong>{playlist.name}</strong>
                    </td>
                    <td>
                      {playlist.topic_keys.length} {playlist.topic_keys.length === 1 ? "topic" : "topics"}
                      {memberNames ? ` · ${memberNames}` : ""}
                    </td>
                    <td>{playlist.aliases.join(", ") || "—"}</td>
                    <td>
                      <Button
                        size="sm"
                        variant={isEditing ? "primary" : "ghost"}
                        onClick={() => setSelected(isEditing ? null : playlist)}
                      >
                        {isEditing ? "Close" : "Edit"}
                      </Button>
                    </td>
                  </tr>
                  {isEditing ? (
                    <InlineEditorRow colSpan={4}>
                      <PlaylistEditor playlist={playlist} subjects={subjects} onDone={() => setSelected(null)} />
                    </InlineEditorRow>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading playlists…</p> : null}
        {query.data?.length === 0 ? <p className="admin-empty">No playlists yet. Theme nights live here, not in the topic column.</p> : null}
      </div>
    </>
  );
}

export function CrawlQueue() {
  const listQueue = useServerFn(fetchCrawlQueue);
  const enqueue = useServerFn(queueCrawl);
  const setPriority = useServerFn(updateCrawlPriority);
  const runTrigger = useServerFn(triggerCrawlAction);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState({ subject: "", priority: "10", refresh: false });
  const [dispatchMsg, setDispatchMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const query = useQuery({
    queryKey: ["crawl", status],
    queryFn: () => listQueue({ data: { status: status || undefined } }),
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["crawl"] });

  const triggerMutation = useMutation({
    mutationFn: () => runTrigger(),
    onSuccess: (res) => {
      setDispatchMsg(res);
      void invalidate();
    },
  });

  const enqueueMutation = useMutation({
    mutationFn: () =>
      enqueue({
        data: {
          subject: draft.subject,
          priority: Number(draft.priority),
          refresh: draft.refresh,
        },
      }),
    onSuccess: async (res) => {
      setDraft({ subject: "", priority: "10", refresh: false });
      setDispatchMsg(
        res.expandedFrom
          ? { ok: true, message: `Enqueued ${res.items.length} topics from playlist ${res.expandedFrom}.` }
          : { ok: true, message: `Enqueued ${res.items[0]?.subject ?? "topic"}.` },
      );
      await invalidate();
    },
  });

  const priorityMutation = useMutation({
    mutationFn: (input: { id: string; priority: number }) => setPriority({ data: input }),
    onSuccess: invalidate,
  });

  return (
    <Card>
      <div className="admin-page-head">
        <CardTitle>Crawl queue</CardTitle>
        <Button
          variant="daily"
          size="sm"
          disabled={triggerMutation.isPending}
          onClick={() => {
            if (window.confirm("Trigger Fact Foundry crawler workflow now?")) {
              triggerMutation.mutate();
            }
          }}
        >
          {triggerMutation.isPending ? "Triggering…" : "Run Fact Foundry now"}
        </Button>
      </div>
      {dispatchMsg ? (
        <p style={{ color: dispatchMsg.ok ? "var(--ds-arena-color-lime)" : "var(--ds-arena-color-red)", fontSize: 13, margin: "6px 0" }}>
          {dispatchMsg.message}
        </p>
      ) : null}
      <p style={{ color: "var(--ds-arena-color-text-muted)", fontSize: 13 }}>
        Enqueue a topic name. If the name matches a playlist, every member topic is queued instead.
      </p>
      <div className="admin-toolbar" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <label className="admin-field" style={{ flex: "1 1 200px" }}>
          <span>Topic or playlist to enqueue</span>
          <input
            className="admin-input"
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Priority</span>
          <input
            className="admin-input"
            type="number"
            min={0}
            max={100}
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
          />
        </label>
        <label className="admin-field">
          <span>Refresh existing</span>
          <input
            type="checkbox"
            checked={draft.refresh}
            style={{ width: 24, height: 24 }}
            onChange={(e) => setDraft({ ...draft, refresh: e.target.checked })}
          />
        </label>
        <Button
          disabled={!draft.subject || enqueueMutation.isPending}
          onClick={() => enqueueMutation.mutate()}
        >
          Enqueue
        </Button>
        <label className="admin-field">
          <span>Filter status</span>
          <select
            className="admin-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            <option value="queued">queued</option>
            <option value="processing">processing</option>
            <option value="done">done</option>
          </select>
        </label>
      </div>
      <ErrorNote error={query.error ?? enqueueMutation.error ?? priorityMutation.error} />
      <div className="admin-table-wrap" style={{ marginTop: "var(--ds-arena-space-3)" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Requested by</th>
              <th>Enqueued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {query.data?.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>{item.subject}</strong>
                  {item.refresh ? " · refresh" : ""}
                </td>
                <td>
                  <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                </td>
                <td>{item.priority}</td>
                <td>{item.requested_by}</td>
                <td>{item.enqueued_at ?? "—"}</td>
                <td>
                  <div className="admin-row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        priorityMutation.mutate({ id: item.id, priority: item.priority + 10 })
                      }
                    >
                      Bump
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        priorityMutation.mutate({
                          id: item.id,
                          priority: Math.max(0, item.priority - 10),
                        })
                      }
                    >
                      Lower
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.isLoading ? <p className="admin-empty">Loading queue…</p> : null}
        {query.data?.length === 0 ? <p className="admin-empty">Queue is empty.</p> : null}
      </div>
    </Card>
  );
}
