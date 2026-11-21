import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { HybridPlugin } from "@opencode/core/plugin/hybrid"
import { HybridExpert } from "@opencode/core/plugin/hybrid/expert"
import { HybridLearned } from "@opencode/core/plugin/hybrid/learned"
import { HybridTrace } from "@opencode/core/plugin/hybrid/trace"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { ConfigModel } from "@opencode/schema/config/model"
import { FSUtil } from "@opencode/util/fs-util"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(FSUtil.node))

const env = { os: "win32", arch: "x64", shell: "powershell", cwd: "C:/work" }

const plan = {
  summary: "Install Python with winget.",
  assumptions: [],
  steps: [
    { id: "s1", goal: "Install", command: "winget install -e --id Python.Python.3.13", verify: "py --version" },
    { id: "s2", goal: "Verify", command: "python --version", expect: "Python 3.13.x" },
  ],
  needs_user: [],
}

describe("HybridExpert", () => {
  test("parses a plan wrapped in prose or a code fence, and fills missing lists", () => {
    const text = 'Here you go:\n```json\n{"summary":"Do it","steps":[{"id":"s1","goal":"Run","command":"echo hi"}]}\n```'
    expect(HybridExpert.parse(text)).toEqual({
      summary: "Do it",
      assumptions: [],
      steps: [{ id: "s1", goal: "Run", command: "echo hi" }],
      needs_user: [],
    })
  })

  test("rejects text without a valid plan", () => {
    expect(HybridExpert.parse("I would use winget.")).toBeUndefined()
    expect(HybridExpert.parse('{"summary": 1}')).toBeUndefined()
  })

  test("builds a follow-up prompt with the environment, the previous plan and the escaped failed step", () => {
    const prompt = HybridExpert.prompt({
      environment: env,
      question: "Install Python",
      previous: plan,
      failed: { id: "s2", command: "python --version", output: "<not found>" },
    })
    expect(prompt).toContain("os=win32 arch=x64 shell=powershell")
    expect(prompt).toContain("<previous_plan>")
    expect(prompt).toContain('<failed_step id="s2">')
    expect(prompt).toContain("&lt;not found&gt;")
    expect(prompt).toContain("corrected plan")
    expect(prompt).not.toContain("${")
  })

  test("formats the plan as numbered steps that name the plan id", () => {
    const text = HybridExpert.format("pln_1", plan)
    expect(text).toContain("Expert plan pln_1: Install Python with winget.")
    expect(text).toContain("1. [s1] Install")
    expect(text).toContain("   command: winget install -e --id Python.Python.3.13")
    expect(text).toContain("   verify: py --version")
    expect(text).toContain('plan_id "pln_1"')
  })

  test("redacts secrets, emails and the home directory", () => {
    const text = HybridExpert.redact(
      "key sk-abcdefghijklmnopqrstuvwx token=hunter2 mail me@example.com at /home/me/project Bearer abcdefghijklmnop",
      "/home/me",
    )
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx")
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("me@example.com")
    expect(text).not.toContain("abcdefghijklmnop")
    expect(text).toContain("~/project")
  })

  test("keeps the last lines of a long output", () => {
    const output = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n")
    const kept = HybridExpert.tail(output, 3)
    expect(kept).toBe("[97 earlier lines omitted]\nline 97\nline 98\nline 99")
  })
})

const turn = (overrides: Partial<HybridLearned.Turn> = {}): HybridLearned.Turn => ({
  sessionID: "ses_1",
  turnID: "msg_1",
  prompt: "python install karo",
  env: { os: "win32", shell: "powershell" },
  expert: "anthropic/claude",
  summaries: ["Install Python with winget."],
  executed: [
    { tool: "shell", summary: "python --version", ok: false, output: "python: The term 'python' is not recognized" },
    { tool: "shell", summary: "winget install -e --id Python.Python.3.13", ok: true, output: "Successfully installed" },
    { tool: "shell", summary: "py --version", ok: true, output: "Python 3.13.1" },
  ],
  delegated: false,
  now: 1_000,
  ...overrides,
})

describe("HybridLearned", () => {
  test("builds a skill from the verified steps, with failures the turn got past as pitfalls", () => {
    const skill = HybridLearned.build(turn())
    expect(skill).toMatchObject({
      id: "python-install-win32",
      status: "candidate",
      executor: "local",
      env: { os: "win32", shell: "powershell" },
      steps: ["`winget install -e --id Python.Python.3.13`", "`py --version`"],
      examples: ["python install karo"],
      trace: [{ session_id: "ses_1", turn_id: "msg_1" }],
    })
    expect(skill?.pitfalls).toEqual(["`python --version` failed: python: The term 'python' is not recognized"])
  })

  test("builds nothing when no step succeeded", () => {
    expect(
      HybridLearned.build(turn({ executed: [{ tool: "shell", summary: "x", ok: false, output: "error" }] })),
    ).toBeUndefined()
  })

  test("merges a newer run: new steps replace old ones, examples and pitfalls accumulate", () => {
    const first = HybridLearned.build(turn())!
    const second = HybridLearned.build(
      turn({
        prompt: "install python please",
        turnID: "msg_2",
        executed: [{ tool: "shell", summary: "winget install Python.Python.3.14", ok: true, output: "ok" }],
        now: 2_000,
      }),
    )!
    const merged = HybridLearned.merge(first, second)
    expect(merged.version).toBe(2)
    expect(merged.steps).toEqual(["`winget install Python.Python.3.14`"])
    expect(merged.examples).toEqual(["python install karo", "install python please"])
    expect(merged.pitfalls).toEqual(first.pitfalls)
    expect(merged.trace.map((item) => item.turn_id)).toEqual(["msg_1", "msg_2"])
  })

  test("promotes a skill after wins and moves repeated escalations to the expert", () => {
    const skill = HybridLearned.build(turn())!
    const trusted = [1, 2, 3].reduce((meta, now) => HybridLearned.record(meta, "win", now), skill)
    expect(trusted).toMatchObject({ status: "trusted", executor: "local", wins: 3, uses: 3 })

    const escalated = [1, 2].reduce((meta, now) => HybridLearned.record(meta, "escalated", now), skill)
    expect(escalated).toMatchObject({ executor: "expert", losses: 2, escalations: 2 })

    const retired = [1, 2, 3].reduce((meta, now) => HybridLearned.record(meta, "loss", now), skill)
    expect(retired.status).toBe("retired")
  })

  test("matches a prompt to a skill of the same OS only, and never to a retired one", () => {
    const skill = HybridLearned.build(turn())!
    expect(HybridLearned.match("please install python", { os: "win32" }, [skill])?.best?.skill.id).toBe(skill.id)
    expect(HybridLearned.match("please install python", { os: "linux" }, [skill])?.best).toBeUndefined()
    expect(HybridLearned.match("deploy the website", { os: "win32" }, [skill])?.best).toBeUndefined()
    expect(
      HybridLearned.match("please install python", { os: "win32" }, [{ ...skill, status: "retired" }])?.best,
    ).toBeUndefined()
  })

  test("renders a SKILL.md with frontmatter, steps and pitfalls", () => {
    const text = HybridLearned.markdown(HybridLearned.build(turn())!)
    expect(text.startsWith("---\nname: python-install-win32\ndescription: ")).toBe(true)
    expect(text).toContain("## Steps\n1. `winget install -e --id Python.Python.3.13`\n2. `py --version`")
    expect(text).toContain("## Pitfalls")
  })

  test("round-trips its bookkeeping and rejects malformed files", () => {
    const skill = HybridLearned.build(turn())!
    expect(HybridLearned.parseMeta(JSON.parse(JSON.stringify(skill)))).toEqual(skill)
    expect(HybridLearned.parseMeta({ id: "x" })).toBeUndefined()
  })
})

describe("HybridTrace", () => {
  test("resolves the first set level", () => {
    expect(HybridTrace.resolve(undefined, "full", "basic")).toBe("full")
    expect(HybridTrace.resolve("nonsense", undefined, "basic")).toBe("basic")
    expect(HybridTrace.resolve(undefined, undefined)).toBe("off")
  })

  test("basic keeps redacted previews, full keeps the redacted text", () => {
    const redacted = `token=[redacted] ${"x".repeat(300)}`
    expect(HybridTrace.shape("basic", { text: `token=abc ${"x".repeat(300)}`, n: 1 }, "/home/me")).toEqual({
      text: `${redacted.slice(0, 200)}… [${redacted.length} chars]`,
      n: 1,
    })
    expect(HybridTrace.shape("full", { list: ["/home/me/a"] }, "/home/me")).toEqual({ list: ["~/a"] })
  })

  it.live("appends events in order to one JSON-lines file per session, and writes nothing when off", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fsUtil = yield* FSUtil.Service
      const trace = HybridTrace.make({ fs: fsUtil, directory: path.join(tmp.path, "traces"), home: "/home/me" })
      yield* trace.record("off", { sessionID: "ses_off", actor: "plugin", type: "ignored", data: {} })
      yield* trace.record("basic", { sessionID: "ses_1", turnID: "msg_1", actor: "local", type: "expert.asked", data: { question: "How?" } })
      yield* trace.record("full", { sessionID: "ses_1", actor: "expert", type: "expert.answered", durationMs: 12, data: { plan: plan } })

      const files = yield* Effect.promise(() => fs.readdir(path.join(tmp.path, "traces")))
      expect(files).toEqual(["ses_1.jsonl"])
      const lines = (yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "traces", "ses_1.jsonl"), "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(lines.map((line) => [line.seq, line.type, line.actor])).toEqual([
        [1, "expert.asked", "local"],
        [2, "expert.answered", "expert"],
      ])
      expect(lines[0]).toMatchObject({ v: 1, level: "basic", session_id: "ses_1", turn_id: "msg_1", data: { question: "How?" } })
      expect(lines[1]).toMatchObject({ duration_ms: 12, data: { plan: { summary: plan.summary } } })
    }),
  )

  it.live("prunes trace files older than the retention", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fsUtil = yield* FSUtil.Service
      const directory = path.join(tmp.path, "traces")
      const trace = HybridTrace.make({ fs: fsUtil, directory, home: "/home/me" })
      yield* trace.record("basic", { sessionID: "old", actor: "plugin", type: "x", data: {} })
      yield* trace.record("basic", { sessionID: "new", actor: "plugin", type: "x", data: {} })
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
      yield* Effect.promise(() => fs.utimes(path.join(directory, "old.jsonl"), old, old))
      yield* trace.prune(30, Date.now())
      expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual(["new.jsonl"])
    }),
  )
})

describe("HybridPlugin.readSettings", () => {
  const document = (hybrid: ConfigExperimental.Info["hybrid"]) =>
    new Document({ type: "document", info: new Info({ experimental: new ConfigExperimental.Info({ hybrid }) }) })

  test("uses defaults when nothing is configured", () => {
    expect(HybridPlugin.readSettings([], "/data")).toEqual({
      perTurn: 3,
      perSession: 10,
      escalateAfter: 2,
      learn: true,
      skillsDirectory: path.join("/data", "hybrid", "skills"),
      retentionDays: 30,
    })
  })

  test("reads each field from the last document that sets it", () => {
    const settings = HybridPlugin.readSettings(
      [
        document({ expert: Schema.decodeUnknownSync(ConfigModel.Selection)("anthropic/claude"), max_consults_per_turn: 5 }),
        document({ trace: "full", learn: false }),
      ],
      "/data",
    )
    expect(settings).toMatchObject({
      expert: { providerID: "anthropic", model: "claude" },
      perTurn: 5,
      trace: "full",
      learn: false,
    })
  })
})
