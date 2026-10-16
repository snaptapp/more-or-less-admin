import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartTooltip, CountBar, StatusPie, label } from "@/admin/charts";
import type { TooltipProps } from "recharts";

describe("admin chart label formatting", () => {
  it("replaces underscores with spaces in string labels", () => {
    expect(label("crawl_pending")).toBe("crawl pending");
    expect(label("film_and_tv")).toBe("film and tv");
    expect(label("active")).toBe("active");
  });

  it("safely handles numbers by converting to string", () => {
    expect(label(2024)).toBe("2024");
    expect(label(0)).toBe("0");
  });

  it("safely handles non-string and non-number values without throwing", () => {
    expect(label(undefined)).toBe("");
    expect(label(null)).toBe("");
    expect(label(() => 42)).toBe("");
    expect(label({})).toBe("");
    expect(label(true)).toBe("");
  });
});

describe("ChartTooltip component", () => {
  it("returns null when inactive or payload is empty", () => {
    const inactiveProps: TooltipProps<number, string> = {
      active: false,
      payload: [{ name: "active", value: 10 }],
    };
    expect(renderToStaticMarkup(createElement(ChartTooltip, inactiveProps))).toBe("");

    const emptyProps: TooltipProps<number, string> = {
      active: true,
      payload: [],
    };
    expect(renderToStaticMarkup(createElement(ChartTooltip, emptyProps))).toBe("");
  });

  it("renders label and formatted value when entry.name is a string", () => {
    const props: TooltipProps<number, string> = {
      active: true,
      payload: [
        {
          name: "crawl_pending",
          value: 1234,
          payload: { name: "crawl_pending", count: 1234 },
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(ChartTooltip, props));
    expect(html).toContain("crawl pending");
    expect(html).toContain("1,234");
  });

  it("does not throw and falls back to axisLabel or payload when entry.name is a function", () => {
    const accessorFn = (row: { count: number }) => row.count;
    const props: TooltipProps<number, string> = {
      active: true,
      label: "film_and_tv",
      payload: [
        {
          name: accessorFn as unknown as string,
          value: 42,
          payload: { name: "film_and_tv", count: 42 },
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(ChartTooltip, props));
    expect(html).toContain("film and tv");
    expect(html).toContain("42");
  });

  it("handles nested recharts payload structure safely", () => {
    const props: TooltipProps<number, string> = {
      active: true,
      payload: [
        {
          name: undefined,
          value: 99,
          payload: {
            payload: { name: "science_and_nature", count: 99 },
          },
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(ChartTooltip, props));
    expect(html).toContain("science and nature");
    expect(html).toContain("99");
  });
});

describe("StatusPie and CountBar rendering", () => {
  const sampleRows = [
    { name: "active", count: 50 },
    { name: "pending", count: 10 },
  ];

  it("renders StatusPie with data without error", () => {
    const html = renderToStaticMarkup(
      createElement(StatusPie, { title: "Fact bank status", rows: sampleRows }),
    );
    expect(html).toContain("Fact bank status");
    expect(html).toContain("active");
    expect(html).toContain("pending");
  });

  it("renders CountBar with data without error", () => {
    const html = renderToStaticMarkup(
      createElement(CountBar, { title: "Crawl queue", rows: sampleRows }),
    );
    expect(html).toContain("Crawl queue");
  });

  it("renders empty states gracefully", () => {
    const pieHtml = renderToStaticMarkup(
      createElement(StatusPie, {
        title: "Empty Pie",
        rows: [],
        emptyMessage: "No pie data",
      }),
    );
    expect(pieHtml).toContain("No pie data");

    const barHtml = renderToStaticMarkup(
      createElement(CountBar, {
        title: "Empty Bar",
        rows: [],
        emptyMessage: "No bar data",
      }),
    );
    expect(barHtml).toContain("No bar data");
  });
});
