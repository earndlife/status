#!/usr/bin/env node
// One run of the checks: every enabled component in components.json is asked twice, the
// answers become a state (lib.mjs classify), status.json is written for the page and the
// day's counters are folded into history.json. Exit code 0 whatever the components say: the
// page reports an outage, the workflow does not fail on one.
//
//   node scripts/probe.mjs --components components.json --history data/history.json --out site
//
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendHistory, classify, emptyHistory, overall, prune } from "./lib.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const componentsPath = option("--components", "components.json");
const historyPath = option("--history", "data/history.json");
const outDir = option("--out", "site");
const attempts = Number(option("--attempts", "2"));

const config = JSON.parse(readFileSync(componentsPath, "utf8"));
const keepDays = config.site?.historyDays ?? 90;

async function sample(component) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), component.timeoutMs ?? 10_000);
  const started = performance.now();
  try {
    const res = await fetch(component.url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": "earnd-status/1.0 (+https://earnd.life)" },
    });
    // The body is read so the measurement is the whole answer, not its first byte.
    await res.arrayBuffer().catch(() => undefined);
    return { ok: true, status: res.status, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
    const cause = err && typeof err === "object" && "cause" in err && err.cause && typeof err.cause === "object" && "code" in err.cause ? String(err.cause.code) : "";
    return { ok: false, error: name === "AbortError" ? "timeout" : cause || (err instanceof Error ? err.message : "failed"), latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(component) {
  const base = { id: component.id, name: component.name, description: component.description, url: component.url };
  if (component.enabled === false) return { ...base, ...classify([], component) };
  const samples = [];
  for (let i = 0; i < attempts; i++) {
    samples.push(await sample(component));
    const last = samples[samples.length - 1];
    if (last.ok && (component.expect ?? [200]).includes(last.status) && last.latencyMs <= (component.degradedMs ?? 3000)) break;
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 2000));
  }
  return { ...base, ...classify(samples, component), attempts: samples.length };
}

const generatedAt = new Date().toISOString();
const components = [];
for (const c of config.components) components.push(await probe(c));
const status = { generatedAt, checkEveryMinutes: config.site?.checkEveryMinutes ?? 30, overall: overall(components), components };

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);

let history = emptyHistory();
if (existsSync(historyPath)) {
  try {
    history = JSON.parse(readFileSync(historyPath, "utf8"));
  } catch {
    history = emptyHistory();
  }
}
history = prune(appendHistory(history, status, generatedAt), generatedAt, keepDays);
mkdirSync(dirname(historyPath), { recursive: true });
writeFileSync(historyPath, `${JSON.stringify(history)}\n`);

for (const c of components) console.log(`${c.state.padEnd(9)} ${c.id.padEnd(18)} ${c.httpStatus ?? "-"} ${c.latencyMs ?? "-"}ms ${c.error ?? ""}`);
console.log(`overall: ${status.overall} at ${generatedAt}`);
