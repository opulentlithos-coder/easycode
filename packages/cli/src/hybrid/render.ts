import { readdir } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import { HybridInsights } from "./insights"

/** Where the core hybrid plugin writes traces and learned skills, on this machine. */
export const directories = () => ({
  traces: path.join(Global.Path.data, "hybrid", "traces"),
  root: path.join(Global.Path.data, "hybrid"),
})

export const load = Effect.fn("cli.hybrid.load")(function* (directory: string) {
  const files = yield* Effect.tryPromise(() => readdir(directory)).pipe(Effect.orElseSucceed((): string[] => []))
  const texts = yield* Effect.forEach(
    files.filter((file) => file.endsWith(".jsonl")),
    (file) => Effect.tryPromise(() => Bun.file(path.join(directory, file)).text()).pipe(Effect.orElseSucceed(() => "")),
    { concurrency: 8 },
  )
  return texts.flatMap(HybridInsights.parse)
})

const LANE: Record<string, string> = {
  user: "USER  ",
  local: "LOCAL ",
  expert: "EXPERT",
  plugin: "PLUGIN",
  skill: "SKILL ",
}

export function report(summary: HybridInsights.Summary, options: { readonly turns: ReadonlyArray<HybridInsights.Turn>; readonly directory: string }) {
  const kpis = summary.kpis
  const handled = Object.entries(kpis.handledBy)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ")
  return [
    `hybrid advisor · ${summary.sessions} session(s) · ${kpis.finished} finished turn(s) · traces: ${options.directory}`,
    kpis.finished === 0
      ? "no finished turns yet"
      : [
          `success ${percent(kpis.successRate)}`,
          `consults/turn ${fixed(kpis.consultsPerTurn)}`,
          `skill hits ${percent(kpis.skillHitRate)}`,
          `delegated ${percent(kpis.delegateRate)}`,
          `learned ${kpis.learned} skill(s)`,
        ].join(" · "),
    ...(handled ? [`handled by: ${handled}`] : []),
    `expert: ${kpis.consults} consult(s), ${kpis.cacheHits} cached, ${(kpis.expertMs / 1000).toFixed(1)}s · ${kpis.triggers} trigger(s)`,
    ...(Object.keys(kpis.reviews).length || Object.keys(kpis.ratings).length
      ? [`expert reviews: ${totals(kpis.reviews)} · user ratings: ${totals(kpis.ratings)}`]
      : []),
    ...options.turns.flatMap((turn) => [
      "",
      `turn ${turn.turnID} (${turn.sessionID}) · ${turn.started.replace("T", " ").slice(0, 19)} · ${turn.outcome ?? "running"}${turn.handledBy ? ` · ${turn.handledBy}` : ""}${turn.durationMs === undefined ? "" : ` · ${(turn.durationMs / 1000).toFixed(1)}s`}`,
      ...turn.timeline.map((entry) => `  ${LANE[entry.actor] ?? entry.actor.toUpperCase().padEnd(6)}  ${entry.text}`),
    ]),
    ...(summary.failures.length
      ? ["", "most failed steps:", ...summary.failures.slice(0, 5).map((item) => `  ${item.count}× ${item.step}`)]
      : []),
  ].join("\n")
}

/** A self-contained page: the summary is embedded as JSON and drawn by a small script, all text through textContent. */
export function dashboard(summary: HybridInsights.Summary, options: { readonly generated: string; readonly directory: string }) {
  const data = JSON.stringify({ summary, ...options }).replaceAll("<", "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hybrid Insights</title>
<style>
:root{--bg:#f7f7f8;--panel:#fff;--text:#1d1d1f;--muted:#6b6b76;--line:#e3e3e8;--accent:#3b6fd8;--ok:#1f8a4c;--bad:#c2372f;--warn:#b7791f;
--user:#6b6b76;--local:#3b6fd8;--expert:#8a4fd1;--plugin:#b7791f;--skill:#1f8a4c}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--panel:#1d1d21;--text:#ececf0;--muted:#9a9aa6;--line:#2e2e35;--accent:#7aa2f7;--ok:#4fc27e;--bad:#f0716a;--warn:#e0b05a;
--user:#9a9aa6;--local:#7aa2f7;--expert:#b88cf5;--plugin:#e0b05a;--skill:#4fc27e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:16px;border-bottom:1px solid var(--line);background:var(--panel)}h1{margin:0;font-size:18px}header p{margin:4px 0 0;color:var(--muted);font-size:12px;word-break:break-all}
nav{display:flex;gap:4px;padding:8px 16px;background:var(--panel);border-bottom:1px solid var(--line);overflow-x:auto}
nav button{border:0;background:none;color:var(--muted);padding:8px 12px;border-radius:6px;cursor:pointer;font:inherit;white-space:nowrap}nav button[aria-selected=true]{background:var(--bg);color:var(--text);font-weight:600}
main{padding:16px;max-width:1200px;margin:0 auto}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:22px}.card span{color:var(--muted);font-size:12px}
.panel{margin-top:16px}.panel h2{margin:0 0 8px;font-size:15px}.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad)}
.bar{display:flex;height:14px;border-radius:4px;overflow:hidden;background:var(--line)}.bar i{display:block}.row{display:grid;grid-template-columns:90px 1fr 40px;gap:8px;align-items:center;margin:4px 0;font-size:12px}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin-top:8px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
.split{display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:16px}@media (max-width:760px){.split{grid-template-columns:1fr}}
.list button{display:block;width:100%;text-align:left;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer;font:inherit}
.list button[aria-selected=true]{border-color:var(--accent)}.list small{display:block;color:var(--muted)}
.event{display:grid;grid-template-columns:70px 1fr;gap:8px;padding:6px 0;border-bottom:1px dashed var(--line);cursor:pointer}.event:last-child{border-bottom:0}
.lane{font-size:11px;font-weight:700;letter-spacing:.04em}.lane.user{color:var(--user)}.lane.local{color:var(--local)}.lane.expert{color:var(--expert)}.lane.plugin{color:var(--plugin)}.lane.skill{color:var(--skill)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font-size:12px;margin:6px 0 0;max-height:360px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.tag{display:inline-block;padding:1px 6px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--muted);margin-left:6px}
</style>
</head>
<body>
<header><h1>Hybrid Insights</h1><p id="meta"></p></header>
<nav id="tabs"></nav>
<main id="view"></main>
<script type="application/json" id="data">${data}</script>
<script>
const input = JSON.parse(document.getElementById("data").textContent)
const s = input.summary
const COLORS = { local: "var(--local)", skill: "var(--skill)", "expert-advice": "var(--expert)", delegate: "var(--bad)", unknown: "var(--muted)",
  success: "var(--ok)", good: "var(--ok)", partial: "var(--warn)", failed: "var(--bad)", bad: "var(--bad)" }
const el = (tag, props, ...children) => {
  const node = document.createElement(tag)
  Object.entries(props || {}).forEach(([key, value]) => key === "class" ? node.className = value : key.startsWith("on") ? node.addEventListener(key.slice(2), value) : node.setAttribute(key, value))
  children.flat().forEach((child) => node.append(child instanceof Node ? child : document.createTextNode(String(child ?? ""))))
  return node
}
const pct = (v) => v === undefined || v === null ? "–" : Math.round(v * 100) + "%"
const fix = (v) => v === undefined || v === null ? "–" : v.toFixed(2)
const when = (at) => at ? at.replace("T", " ").slice(0, 19) : ""
const json = (v) => el("pre", {}, JSON.stringify(v, null, 2))
document.getElementById("meta").textContent = "Generated " + when(input.generated) + " · " + s.sessions + " session(s) · traces: " + input.directory

const tabs = { Overview: overview, Turns: turns, "Expert Q&A": qa, "Local performance": local, Feedback: feedback, Skills: skills }
let current = "Overview"
function draw() {
  const nav = document.getElementById("tabs")
  nav.replaceChildren(...Object.keys(tabs).map((name) => el("button", { "aria-selected": String(name === current), onclick: () => { current = name; draw() } }, name)))
  document.getElementById("view").replaceChildren(tabs[current]())
}

function overview() {
  const k = s.kpis
  const card = (value, label) => el("div", { class: "card" }, el("b", {}, value), el("span", {}, label))
  const total = (h) => Object.values(h).reduce((a, b) => a + b, 0)
  const bar = (h) => el("div", { class: "bar" }, Object.entries(h).map(([key, value]) => el("i", { style: "width:" + (value / Math.max(1, total(h)) * 100) + "%;background:" + (COLORS[key] || "var(--accent)"), title: key + ": " + value })))
  return el("div", {},
    el("div", { class: "cards" },
      card(k.finished, "finished turns"), card(pct(k.successRate), "success rate"), card(fix(k.consultsPerTurn), "expert consults / turn"),
      card(pct(k.skillHitRate), "handled by a learned skill"), card(pct(k.delegateRate), "delegated to the expert"), card(k.learned, "skills learned"),
      card(k.consults + " (" + k.cacheHits + " cached)", "expert consults"), card((k.expertMs / 1000).toFixed(1) + "s", "time waiting on the expert")),
    el("div", { class: "panel" }, el("h2", {}, "Who handled each turn"), bar(k.handledBy),
      el("div", { class: "legend" }, Object.entries(k.handledBy).map(([key, value]) => el("span", {}, el("i", { style: "background:" + (COLORS[key] || "var(--accent)") }), key + " " + value)))),
    el("div", { class: "panel" }, el("h2", {}, "By day (dependency on the expert should shrink over time)"),
      s.daily.length ? s.daily.map((day) => el("div", { class: "row" }, el("span", { class: "muted" }, day.day), bar(day.handledBy), el("span", { class: "muted" }, total(day.handledBy)))) : el("p", { class: "muted" }, "No finished turns yet.")))
}

let selected = 0
function turns() {
  if (!s.turns.length) return el("p", { class: "muted" }, "No traced turns yet. Run with --hybrid-trace=full or use /hybrid-trace full in a session.")
  const turn = s.turns[selected] || s.turns[0]
  const detail = el("div", { class: "panel" },
    el("h2", {}, turn.prompt || turn.turnID),
    el("p", { class: "muted" }, when(turn.started) + " · " + (turn.outcome || "running") + (turn.handledBy ? " · " + turn.handledBy : "") + " · " + turn.consults + " consult(s)" + (turn.learned ? " · learned " + turn.learned : "")),
    turn.timeline.map((entry) => {
      const extra = el("div", { hidden: "" }, json(entry.data))
      return el("div", { class: "event", onclick: () => extra.toggleAttribute("hidden") },
        el("span", { class: "lane " + entry.actor }, entry.actor.toUpperCase()),
        el("div", {}, el("span", { class: entry.ok === false ? "bad" : entry.ok ? "ok" : "" }, entry.text), el("span", { class: "tag" }, entry.type), extra))
    }))
  return el("div", { class: "split" },
    el("div", { class: "list" }, s.turns.map((item, index) => el("button", { "aria-selected": String(index === selected), onclick: () => { selected = index; draw() } },
      (item.prompt || item.turnID).slice(0, 80), el("small", {}, when(item.started) + " · " + (item.handledBy || item.outcome || "running"))))),
    detail)
}

function qa() {
  if (!s.consults.length) return el("p", { class: "muted" }, "The local model has not asked the expert anything yet.")
  return el("div", {}, s.consults.toReversed().map((item) => el("div", { class: "panel" },
    el("h2", {}, (item.followUp ? "Follow-up: " : "") + item.question),
    el("p", { class: "muted" }, when(item.at) + " · " + (item.model || "") + (item.durationMs !== undefined ? " · " + (item.durationMs / 1000).toFixed(1) + "s" : "") + (item.cacheHit ? " · cached" : "") + (item.planID ? " · " + item.planID : "")),
    item.failedStep ? el("div", {}, el("b", {}, "Failed step sent"), json(item.failedStep)) : "",
    item.summary ? el("p", {}, el("b", {}, "Expert: "), item.summary) : "",
    Array.isArray(item.steps) ? el("ol", {}, item.steps.map((step) => el("li", {}, step.goal || "", step.command ? el("pre", {}, step.command + (step.verify ? "\\n# verify: " + step.verify : "")) : ""))) : "",
    item.text ? json(item.text) : "")))
}

function local() {
  const triggers = s.turns.flatMap((turn) => turn.timeline.filter((entry) => entry.type === "trigger.fired").map((entry) => ({ turn, entry })))
  const delegated = s.turns.filter((turn) => turn.handledBy === "delegate")
  return el("div", {},
    el("div", { class: "panel" }, el("h2", {}, "Steps the local model failed"), s.failures.length ? el("table", {},
      el("tr", {}, el("th", {}, "Times"), el("th", {}, "Step"), el("th", {}, "Last output")),
      s.failures.map((item) => el("tr", {}, el("td", {}, item.count), el("td", {}, item.step), el("td", {}, el("pre", {}, item.lastOutput))))) : el("p", { class: "muted" }, "No failed steps.")),
    el("div", { class: "panel" }, el("h2", {}, "Where it got stuck (triggers)"), triggers.length ? el("table", {},
      el("tr", {}, el("th", {}, "When"), el("th", {}, "Turn"), el("th", {}, "What happened")),
      triggers.map(({ turn, entry }) => el("tr", {}, el("td", {}, when(entry.at)), el("td", {}, (turn.prompt || turn.turnID).slice(0, 60)), el("td", {}, entry.text)))) : el("p", { class: "muted" }, "No triggers fired.")),
    el("div", { class: "panel" }, el("h2", {}, "Handed to the expert"), delegated.length ? delegated.map((turn) => el("p", {}, when(turn.started) + " · " + turn.prompt)) : el("p", { class: "muted" }, "Nothing was delegated.")))
}

function feedback() {
  const rows = s.turns.filter((turn) => turn.review || turn.rating)
  const summary = (title, counts) => el("div", { class: "card" }, el("span", {}, title),
    el("div", { class: "legend" }, Object.keys(counts).length ? Object.entries(counts).map(([key, value]) => el("span", {}, el("i", { style: "background:" + (COLORS[key] || "var(--accent)") }), key + " " + value)) : el("span", { class: "muted" }, "none yet")))
  return el("div", {},
    el("div", { class: "cards" }, summary("Expert reviews of the local model's work", s.kpis.reviews), summary("User ratings", s.kpis.ratings)),
    rows.length ? rows.map((turn) => el("div", { class: "panel" },
      el("h2", {}, turn.prompt || turn.turnID),
      el("p", { class: "muted" }, when(turn.started) + " · " + (turn.outcome || "running") + (turn.handledBy ? " · " + turn.handledBy : "")),
      turn.review ? el("div", {}, el("b", { class: turn.review.verdict === "failed" ? "bad" : turn.review.verdict === "success" ? "ok" : "" }, "Expert: " + turn.review.verdict), " ", turn.review.reason,
        turn.review.lessons.length ? el("ul", {}, turn.review.lessons.map((lesson) => el("li", {}, lesson))) : "") : "",
      turn.rating ? el("p", {}, el("b", { class: turn.rating.rating === "bad" ? "bad" : turn.rating.rating === "good" ? "ok" : "" }, "User: " + turn.rating.rating), turn.rating.note ? " · " + turn.rating.note : "") : ""))
      : el("p", { class: "muted" }, "No reviews or ratings yet. The expert reviews turns it helped with (experimental.hybrid.review); rate a turn with /hybrid-feedback good|partial|bad."))
}

function skills() {
  if (!s.skills.length) return el("p", { class: "muted" }, "No skills learned yet.")
  return el("div", {}, s.skills.map((skill) => {
    const last = skill.events[skill.events.length - 1]
    return el("div", { class: "panel" },
      el("h2", {}, skill.id, last && last.data.status && last.data.status.to ? el("span", { class: "tag" }, last.data.status.to) : ""),
      skill.path ? el("p", { class: "muted" }, skill.path) : "",
      el("table", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "Event"), el("th", {}, "Details")),
        skill.events.map((event) => el("tr", {}, el("td", {}, when(event.at)), el("td", {}, event.type), el("td", {},
          event.data.outcome ? "outcome: " + event.data.outcome + " · " : "",
          event.data.rating ? "user: " + event.data.rating + (event.data.note ? " (" + event.data.note + ")" : "") + " · " : "",
          Array.isArray(event.data.lessons) && event.data.lessons.length ? el("pre", {}, "Lessons from the expert review:\\n" + event.data.lessons.join("\\n")) : "",
          event.data.version ? "v" + event.data.version + " · " : "",
          Array.isArray(event.data.steps) && event.data.steps.length ? el("pre", {}, "Steps:\\n" + event.data.steps.join("\\n") + (Array.isArray(event.data.pitfalls) && event.data.pitfalls.length ? "\\n\\nPitfalls:\\n" + event.data.pitfalls.join("\\n") : "")) : "",
          event.data.counters ? json(event.data.counters) : "")))))
  }))
}

draw()
</script>
</body>
</html>
`
}

function totals(counts: Record<string, number>) {
  const entries = Object.entries(counts)
  return entries.length ? entries.map(([key, value]) => `${key} ${value}`).join(", ") : "none"
}

function percent(value: number | undefined) {
  return value === undefined ? "–" : `${Math.round(value * 100)}%`
}

function fixed(value: number | undefined) {
  return value === undefined ? "–" : value.toFixed(2)
}

export * as HybridRender from "./render"
