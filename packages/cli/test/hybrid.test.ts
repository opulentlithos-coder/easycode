import { describe, expect, test } from "bun:test"
import { HybridInsights } from "../src/hybrid/insights"
import { HybridRender } from "../src/hybrid/render"

const line = (seq: number, at: string, actor: string, type: string, data: Record<string, unknown>, extra = {}) =>
  JSON.stringify({ v: 1, at, seq, level: "full", session_id: "ses_1", turn_id: "msg_1", actor, type, data, ...extra })

const trace = [
  line(1, "2026-11-21T10:00:00.000Z", "user", "turn.started", { prompt: "python install karo" }),
  line(2, "2026-11-21T10:00:00.100Z", "plugin", "skill.searched", { candidates: [], chosen: null }),
  line(3, "2026-11-21T10:00:01.000Z", "local", "expert.asked", { question: "Install Python", follow_up: false, cache_hit: false }),
  line(
    4,
    "2026-11-21T10:00:04.000Z",
    "expert",
    "expert.answered",
    {
      plan_id: "pln_1",
      model: "anthropic/claude",
      parse_ok: true,
      steps: 1,
      summary: "Use winget",
      plan: { steps: [{ id: "s1", goal: "Install", command: "winget install Python.Python.3.13" }] },
    },
    { duration_ms: 3000 },
  ),
  line(5, "2026-11-21T10:00:10.000Z", "local", "step.executed", { summary: "python --version", ok: false, exit_code: 1, output: "not found" }),
  line(6, "2026-11-21T10:00:20.000Z", "local", "step.executed", { summary: "winget install Python.Python.3.13", ok: true, exit_code: 0, output: "ok" }),
  line(7, "2026-11-21T10:00:21.000Z", "skill", "skill.created", { skill_id: "python-install-win32", version: 1, steps: ["`winget install`"], pitfalls: [], path: "/x/SKILL.md" }),
  line(8, "2026-11-21T10:00:21.100Z", "plugin", "turn.finished", { outcome: "success", handled_by: "expert-advice", consults: 1, learned: "python-install-win32" }, { duration_ms: 21_100 }),
  "not json",
  JSON.stringify({ v: 2, unknown: true }),
].join("\n")

describe("HybridInsights", () => {
  test("parses trace lines and skips anything else", () => {
    expect(HybridInsights.parse(trace).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test("summarizes turns, consults, failures and skills", () => {
    const summary = HybridInsights.summarize(HybridInsights.parse(trace))
    expect(summary.sessions).toBe(1)
    expect(summary.kpis).toMatchObject({
      finished: 1,
      successRate: 1,
      consultsPerTurn: 1,
      skillHitRate: 0,
      handledBy: { "expert-advice": 1 },
      consults: 1,
      cacheHits: 0,
      expertMs: 3000,
      learned: 1,
    })
    expect(summary.turns[0]).toMatchObject({
      prompt: "python install karo",
      outcome: "success",
      handledBy: "expert-advice",
      learned: "python-install-win32",
      durationMs: 21_100,
    })
    expect(summary.consults[0]).toMatchObject({ question: "Install Python", planID: "pln_1", summary: "Use winget", durationMs: 3000 })
    expect(summary.failures).toEqual([{ step: "python --version", count: 1, lastOutput: "not found", lastAt: "2026-11-21T10:00:10.000Z" }])
    expect(summary.skills.map((skill) => [skill.id, skill.path, skill.events.length])).toEqual([["python-install-win32", "/x/SKILL.md", 1]])
    expect(summary.daily).toEqual([{ day: "2026-11-21", handledBy: { "expert-advice": 1 } }])
  })

  test("describes events in plain words", () => {
    const texts = HybridInsights.summarize(HybridInsights.parse(trace)).turns[0]!.timeline.map((entry) => entry.text)
    expect(texts).toContain('asked expert: "Install Python"')
    expect(texts).toContain("plan pln_1: 1 steps · Use winget")
    expect(texts).toContain("✗ python --version (exit 1)")
    expect(texts).toContain("learned new skill python-install-win32 (v1, 1 steps)")
  })
})

describe("HybridRender", () => {
  test("prints KPIs and the turn timeline", () => {
    const summary = HybridInsights.summarize(HybridInsights.parse(trace))
    const text = HybridRender.report(summary, { turns: summary.turns, directory: "/traces" })
    expect(text).toContain("success 100% · consults/turn 1.00")
    expect(text).toContain('  USER    "python install karo"')
    expect(text).toContain("  EXPERT  plan pln_1")
    expect(text).toContain("most failed steps:\n  1× python --version")
  })

  test("writes a self-contained dashboard whose data cannot close its script tag", () => {
    const summary = HybridInsights.summarize(
      HybridInsights.parse(line(1, "2026-11-21T10:00:00.000Z", "user", "turn.started", { prompt: "</script><b>x</b>" })),
    )
    const html = HybridRender.dashboard(summary, { generated: "2026-11-21T10:00:00.000Z", directory: "/traces" })
    expect(html.match(/<\/script>/g)?.length).toBe(2)
    expect(html).toContain("\\u003c/script>")
    const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"))
    expect(() => new Function(script)).not.toThrow()
  })
})
