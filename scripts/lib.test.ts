import { describe, expect, it } from "vitest";
import {
  appendHistory,
  classify,
  dayState,
  emptyHistory,
  overall,
  parseIncident,
  prune,
  sortIncidents,
  uptimeOf,
  type Sample,
} from "./lib.mjs";

/** The rules the status page lives by (status/README.md). */
const ok = (status: number, latencyMs: number): Sample => ({ ok: true, status, latencyMs });
const dead = (error: string): Sample => ({ ok: false, error });

describe("classify", () => {
  it("is up when an expected answer came back quickly on every attempt", () => {
    expect(classify([ok(200, 300), ok(200, 280)], { expect: [200], degradedMs: 3000 })).toEqual({
      state: "up",
      httpStatus: 200,
      latencyMs: 280,
      error: null,
    });
  });

  it("is degraded when the best answer was slow, or one attempt failed", () => {
    expect(classify([ok(200, 3500)], { degradedMs: 3000 }).state).toBe("degraded");
    const flaky = classify([dead("timeout"), ok(200, 200)], { degradedMs: 3000 });
    expect(flaky.state).toBe("degraded");
    expect(flaky.error).toBe("one attempt failed");
  });

  it("is down when nothing expected came back, and says why", () => {
    expect(classify([dead("ECONNREFUSED"), dead("timeout")], {})).toEqual({
      state: "down",
      httpStatus: null,
      latencyMs: null,
      error: "timeout",
    });
    expect(classify([ok(503, 90), ok(503, 95)], { expect: [200] })).toMatchObject({ state: "down", httpStatus: 503, error: "answered 503" });
  });

  it("leaves a disabled component alone", () => {
    expect(classify([], { enabled: false })).toEqual({ state: "disabled", httpStatus: null, latencyMs: null, error: null });
  });
});

describe("overall", () => {
  it("is the worst enabled state, and unknown when nothing is enabled", () => {
    expect(overall([{ state: "up" }, { state: "disabled" }])).toBe("up");
    expect(overall([{ state: "up" }, { state: "degraded" }])).toBe("degraded");
    expect(overall([{ state: "degraded" }, { state: "down" }])).toBe("down");
    expect(overall([{ state: "disabled" }])).toBe("unknown");
  });
});

describe("history", () => {
  const status = (state: "up" | "degraded" | "down" | "disabled", at: string) => ({
    generatedAt: at,
    components: [
      { id: "website", name: "earnd.life", url: "https://earnd.life/", state, httpStatus: 200, latencyMs: 1, error: null },
      { id: "later", name: "later", url: "https://later.example/health", state: "disabled" as const, httpStatus: null, latencyMs: null, error: null },
    ],
  });

  it("counts each run under its UTC day, per component, and never a disabled one", () => {
    let h = appendHistory(emptyHistory(), status("up", "2026-10-19T18:30:00Z"));
    h = appendHistory(h, status("down", "2026-10-19T19:00:00Z"));
    h = appendHistory(h, status("up", "2026-10-19T23:59:59Z"));
    // 20:00Z is 01:30 IST on the 20th: the day is UTC's, not the reader's.
    h = appendHistory(h, status("degraded", "2026-10-20T00:00:00Z"));
    expect(h.days["2026-10-19"]).toEqual({ website: { checks: 3, up: 2, degraded: 0, down: 1 } });
    expect(h.days["2026-10-20"]).toEqual({ website: { checks: 1, up: 0, degraded: 1, down: 0 } });
    expect(h.days["2026-10-19"]!.later).toBeUndefined();
  });

  it("gives uptime as the share of checks that were not down, degraded counting as up", () => {
    let h = appendHistory(emptyHistory(), status("up", "2026-10-19T18:30:00Z"));
    h = appendHistory(h, status("down", "2026-10-19T19:00:00Z"));
    h = appendHistory(h, status("degraded", "2026-10-19T19:30:00Z"));
    h = appendHistory(h, status("up", "2026-10-19T20:00:00Z"));
    expect(uptimeOf(h, "website", 90, "2026-10-19T21:00:00Z")).toBe(0.75);
    expect(uptimeOf(h, "later", 90, "2026-10-19T21:00:00Z")).toBeNull();
    // A window that does not reach the day sees nothing.
    expect(uptimeOf(h, "website", 1, "2026-10-25T00:00:00Z")).toBeNull();
  });

  it("prunes days outside the window, keeping exactly keepDays", () => {
    let h = emptyHistory();
    for (let d = 1; d <= 120; d++) h = appendHistory(h, status("up", `2026-01-${String(1).padStart(2, "0")}T00:00:00Z`), new Date(Date.UTC(2026, 0, d)));
    const kept = prune(h, new Date(Date.UTC(2026, 3, 30)), 90); // 30 April
    expect(Object.keys(kept.days)).toHaveLength(90);
    expect(Object.keys(kept.days).sort()[0]).toBe("2026-01-31");
  });

  it("names a day by the worst thing that happened in it", () => {
    expect(dayState(undefined)).toBe("none");
    expect(dayState({ checks: 4, up: 4, degraded: 0, down: 0 })).toBe("up");
    expect(dayState({ checks: 4, up: 3, degraded: 1, down: 0 })).toBe("degraded");
    expect(dayState({ checks: 4, up: 3, degraded: 0, down: 1 })).toBe("down");
  });
});

describe("incidents", () => {
  const good = `---
title: Waitlist emails delayed
status: resolved
started: 2026-10-19T10:00:00+05:30
resolved: 2026-10-19T10:40:00+05:30
components: waitlist, website
---
10:00 IST: confirmation emails were queued but not sent.

10:40 IST: the sending budget had been reached by a burst of sign-ups; raised for the day.`;

  it("reads the front matter and the body, with times in UTC", () => {
    const { incident, problems } = parseIncident("2026-10-19-waitlist", good);
    expect(problems).toEqual([]);
    expect(incident).toMatchObject({
      slug: "2026-10-19-waitlist",
      title: "Waitlist emails delayed",
      status: "resolved",
      started: "2026-10-19T04:30:00.000Z",
      resolved: "2026-10-19T05:10:00.000Z",
      components: ["waitlist", "website"],
    });
    expect(incident!.body.startsWith("10:00 IST")).toBe(true);
  });

  it("refuses what the page could not show, naming each problem", () => {
    const { incident, problems } = parseIncident("x", "---\nstatus: fixed\nstarted: yesterday\n---\n");
    expect(incident).toBeNull();
    expect(problems).toEqual([
      "no title",
      "status must be one of investigating, identified, monitoring, resolved",
      "started must be a date-time",
    ]);
    expect(parseIncident("y", "---\ntitle: t\nstatus: resolved\nstarted: 2026-10-19T10:00:00Z\n---\n").problems).toEqual([
      "a resolved incident needs a resolved time",
    ]);
  });

  it("puts open incidents first, then the newest", () => {
    const mk = (slug: string, status: "resolved" | "monitoring", started: string) => ({
      slug,
      title: slug,
      status,
      started,
      resolved: null,
      components: [],
      body: "",
    });
    const sorted = sortIncidents([
      mk("old", "resolved", "2026-01-01T00:00:00Z"),
      mk("new", "resolved", "2026-03-01T00:00:00Z"),
      mk("open", "monitoring", "2026-02-01T00:00:00Z"),
    ]);
    expect(sorted.map((i) => i.slug)).toEqual(["open", "new", "old"]);
  });
});
