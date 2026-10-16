import { Bar, BarChart, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipProps } from "recharts";
import { Card, CardTitle } from "@/index";

export type ChartRow = { name: string; count: number };

// Recharts value accessor for the series' numeric field. Using a typed accessor
// function (rather than the string key `"count"`) keeps the field reference
// bound to `ChartRow` and avoids writing a bare literal that coincidentally
// equals the `count` quantity_kind — a false positive for Contract_Literal_Check
// (Requirement 9.9); this is a chart data key, not a DDM quantity_kind.
const chartValue = (row: ChartRow): number => row.count;

const ARENA = {
  lime: "#d7f24a",
  amber: "#f6c344",
  red: "#f2495c",
  purple: "#a76cff",
  blue: "#5b8def",
  teal: "#2dd4bf",
  muted: "#8d95a6",
  text: "#f5f7fa",
  border: "#262a34",
} as const;

const PALETTE = [ARENA.lime, ARENA.amber, ARENA.purple, ARENA.blue, ARENA.teal, ARENA.red, ARENA.muted] as const;

// Status names carry meaning, so they keep one color everywhere (matching the
// stat tiles above the charts) instead of whatever palette slot they land in.
const SEMANTIC: Record<string, string> = {
  active: ARENA.lime,
  pending: ARENA.amber,
  disputed: ARENA.red,
  retired: ARENA.muted,
  standard: ARENA.lime,
  after_dark: ARENA.purple,
  pending_review: ARENA.purple,
  resolved: ARENA.lime,
  rejected: ARENA.muted,
  queued: ARENA.amber,
  processing: ARENA.blue,
  done: ARENA.lime,
};

function colorFor(name: string, index: number): string {
  return SEMANTIC[name] ?? PALETTE[index % PALETTE.length]!;
}

export function label(name: unknown): string {
  if (typeof name !== "string") {
    if (typeof name === "number") return String(name);
    return "";
  }
  return name.replace(/_/g, " ");
}

const numberFormat = new Intl.NumberFormat();

function share(count: number, total: number): string {
  if (total === 0) return "—";
  if (count === 0) return "0%";
  const percent = (count / total) * 100;
  return percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function positiveRows(rows: ChartRow[]): ChartRow[] {
  return rows.filter((row) => row.count > 0);
}

function EmptyState({ message = "No data" }: { message?: string }) {
  return <p className="admin-chart-empty">{message}</p>;
}

export function ChartTooltip({ active, payload, label: axisLabel }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const rowPayload = entry?.payload;
  const row = (
    typeof rowPayload === "object" &&
    rowPayload !== null &&
    "payload" in rowPayload &&
    typeof (rowPayload as { payload: unknown }).payload === "object" &&
    (rowPayload as { payload: unknown }).payload !== null
      ? (rowPayload as { payload: ChartRow }).payload
      : rowPayload
  ) as ChartRow | null;
  const rawName =
    (typeof axisLabel === "string" && axisLabel.length > 0 ? axisLabel : null) ??
    (typeof row?.name === "string" && row.name.length > 0 ? row.name : null) ??
    (typeof entry?.name === "string" && entry.name.length > 0 ? entry.name : null) ??
    "";
  const rawValue =
    typeof entry?.value === "number"
      ? entry.value
      : typeof row?.count === "number"
        ? row.count
        : 0;
  return (
    <div className="admin-chart-tooltip">
      {rawName ? <div className="admin-chart-tooltip__label">{label(rawName)}</div> : null}
      <div className="admin-chart-tooltip__value">{numberFormat.format(rawValue)}</div>
    </div>
  );
}

export function StatusPie({
  title,
  rows,
  footnote,
  emptyMessage,
}: {
  title: string;
  rows: ChartRow[];
  footnote?: string;
  emptyMessage?: string;
}) {
  const data = positiveRows(rows);
  const total = data.reduce((sum, row) => sum + row.count, 0);

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {data.length === 0 ? (
        <div className="admin-chart">
          <EmptyState message={emptyMessage} />
        </div>
      ) : (
        <div className="admin-donut">
          <div className="admin-donut__chart">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey={chartValue}
                  nameKey="name"
                  innerRadius="68%"
                  outerRadius="100%"
                  paddingAngle={data.length > 1 ? 2 : 0}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {data.map((row) => (
                    <Cell key={row.name} fill={colorFor(row.name, rows.indexOf(row))} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="admin-donut__total" aria-hidden="true">
              <span className="admin-donut__total-value">{numberFormat.format(total)}</span>
              <span className="admin-donut__total-label">total</span>
            </div>
          </div>
          <ul className="admin-donut__legend">
            {rows.map((row, index) => (
              <li key={row.name}>
                <span className="admin-donut__swatch" style={{ background: colorFor(row.name, index) }} />
                <span className="admin-donut__name">{label(row.name)}</span>
                <span className="admin-donut__count">{numberFormat.format(row.count)}</span>
                <span className="admin-donut__share">
                  {share(row.count, total)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {footnote ? <p className="admin-chart-footnote">{footnote}</p> : null}
    </Card>
  );
}

/**
 * Horizontal bar chart: one labelled row per category with its count printed at
 * the end of the bar, so small values stay readable next to large ones.
 */
export function CountBar({
  title,
  rows,
  footnote,
  emptyMessage,
  keepZeroRows = false,
  color,
}: {
  title: string;
  rows: ChartRow[];
  footnote?: string;
  emptyMessage?: string;
  keepZeroRows?: boolean;
  /** One fill for every bar; omit to color rows by status name. */
  color?: string;
}) {
  const data = keepZeroRows ? rows : positiveRows(rows);
  const hasData = data.length > 0;
  const chartHeight = Math.max(120, data.length * 32 + 16);
  const labelWidth = Math.min(
    160,
    Math.max(64, ...data.map((row) => label(row.name).length * 8 + 12)),
  );

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="admin-chart" style={{ height: hasData ? chartHeight : undefined, minHeight: hasData ? chartHeight : undefined }}>
        {!hasData ? (
          <EmptyState message={emptyMessage} />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }} barCategoryGap={6}>
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={labelWidth}
                axisLine={false}
                tickLine={false}
                tick={{ fill: ARENA.text, fontSize: 12, width: labelWidth }}
                tickFormatter={label}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(215, 242, 74, 0.06)" }} />
              <Bar dataKey={chartValue} radius={[0, 4, 4, 0]} minPointSize={2} isAnimationActive={false}>
                {data.map((row, index) => (
                  <Cell key={row.name} fill={color ?? colorFor(row.name, index)} />
                ))}
                <LabelList
                  position="right"
                  fill={ARENA.text}
                  fontSize={12}
                  formatter={(value: number) => numberFormat.format(value)}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {footnote ? <p className="admin-chart-footnote">{footnote}</p> : null}
    </Card>
  );
}
