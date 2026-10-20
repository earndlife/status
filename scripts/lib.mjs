// The status page's logic with nothing async in it: how samples become a state, how a day's
// history accumulates, what an uptime figure is, and how an incident file is read. probe.mjs and
// build.mjs are the thin CLIs around it; lib.test.ts (run by the website's vitest) pins the rules.

/** How a component ended up after its samples. */
export const STATES = ["up", "degraded", "down", "disabled"];

/**
 * One sample is one request. `ok` is whether a response arrived at all; `status` and `latencyMs`
 * when it did; `error` when it did not (a timeout, a refused connection, a DNS miss).
 */
export function classify(samples, component) {
  if (component.enabled === false) return { state: "disabled", httpStatus: null, latencyMs: null, error: null };
  const expect = component.expect ?? [200];
  const good = samples.filter((s) => s.ok && expect.includes(s.status));
  if (good.length === 0) {
    const last = samples[samples.length - 1];
    return {
      state: "down",
      httpStatus: last?.ok ? last.status : null,
      latencyMs: last?.latencyMs ?? null,
      error: last?.ok ? `answered ${last.status}` : (last?.error ?? "no answer"),
    };
  }
  const best = good.reduce((a, b) => (a.latencyMs <= b.latencyMs ? a : b));
  const slow = best.latencyMs > (component.degradedMs ?? 3000);
  const flaky = good.length < samples.length;
  return {
    state: slow || flaky ? "degraded" : "up",
    httpStatus: best.status,
    latencyMs: best.latencyMs,
    error: flaky ? "one attempt failed" : slow ? "slow" : null,
  };
}

/** The page's overall banner: the worst state among enabled components. */
export function overall(components) {
  const live = components.filter((c) => c.state !== "disabled");
  if (live.length === 0) return "unknown";
  if (live.some((c) => c.state === "down")) return "down";
  if (live.some((c) => c.state === "degraded")) return "degraded";
  return "up";
}

/** The UTC calendar day of an instant. */
export function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/** An empty history. */
export function emptyHistory() {
  return { version: 1, days: {} };
}

/** One run's results folded into the per-day counters. Disabled components leave no mark. */
export function appendHistory(history, status, now = status.generatedAt) {
  const next = { version: 1, days: { ...(history?.days ?? {}) } };
  const day = utcDay(now);
  const today = { ...(next.days[day] ?? {}) };
  for (const c of status.components) {
    if (c.state === "disabled") continue;
    const counters = { checks: 0, up: 0, degraded: 0, down: 0, ...(today[c.id] ?? {}) };
    counters.checks += 1;
    counters[c.state] += 1;
    today[c.id] = counters;
  }
  next.days[day] = today;
  return next;
}

/** Days older than `keepDays` before `now` are dropped, so the file stays small. */
export function prune(history, now, keepDays = 90) {
  const cutoff = utcDay(new Date(new Date(now).getTime() - (keepDays - 1) * 86_400_000));
  const days = Object.fromEntries(Object.entries(history.days ?? {}).filter(([day]) => day >= cutoff));
  return { version: 1, days };
}

/**
 * Uptime over the last `days` days as a share of checks that were not down, or null with no
 * checks. Degraded counts as up: slow is not out.
 */
export function uptimeOf(history, id, days, now) {
  const cutoff = utcDay(new Date(new Date(now).getTime() - (days - 1) * 86_400_000));
  let checks = 0;
  let down = 0;
  for (const [day, byId] of Object.entries(history.days ?? {})) {
    if (day < cutoff) continue;
    const c = byId[id];
    if (!c) continue;
    checks += c.checks;
    down += c.down;
  }
  return checks === 0 ? null : (checks - down) / checks;
}

/** The state of one component on one day, for the 90-square strip: the worst thing that happened. */
export function dayState(counters) {
  if (!counters || counters.checks === 0) return "none";
  if (counters.down > 0) return "down";
  if (counters.degraded > 0) return "degraded";
  return "up";
}

// ── Incidents ──────────────────────────────────────────────────────────────
// A markdown file per incident, with a small front matter. Written by a person, by hand, in
// the public repository; the next run publishes it. Nothing here parses YAML in general: a
// `key: value` line per field is all an incident needs.
export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"];

export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: {}, body: text.trim() };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { fields, body: m[2].trim() };
}

/** An incident, or null (and a reason) when the file is not one the page can show. */
export function parseIncident(slug, text) {
  const { fields, body } = parseFrontMatter(text);
  const problems = [];
  if (!fields.title) problems.push("no title");
  if (!INCIDENT_STATUSES.includes(fields.status)) problems.push(`status must be one of ${INCIDENT_STATUSES.join(", ")}`);
  if (!fields.started || Number.isNaN(Date.parse(fields.started))) problems.push("started must be a date-time");
  if (fields.resolved && Number.isNaN(Date.parse(fields.resolved))) problems.push("resolved must be a date-time");
  if (fields.status === "resolved" && !fields.resolved) problems.push("a resolved incident needs a resolved time");
  if (problems.length) return { incident: null, problems };
  return {
    incident: {
      slug,
      title: fields.title,
      status: fields.status,
      started: new Date(fields.started).toISOString(),
      resolved: fields.resolved ? new Date(fields.resolved).toISOString() : null,
      components: (fields.components ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      body,
    },
    problems: [],
  };
}

/** Newest first; unresolved ones first among equals. */
export function sortIncidents(list) {
  return [...list].sort((a, b) => {
    const open = Number(a.status !== "resolved") - Number(b.status !== "resolved");
    if (open !== 0) return -open;
    return b.started.localeCompare(a.started);
  });
}
