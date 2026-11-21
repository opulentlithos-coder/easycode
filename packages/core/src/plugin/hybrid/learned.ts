export * as HybridLearned from "./learned.js"

import { Option, Schema } from "effect"

/** Bookkeeping kept beside each learned SKILL.md, so the skill file stays plain for the model. */
export const Meta = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["candidate", "trusted", "retired"]),
  executor: Schema.Literals(["local", "expert"]),
  env: Schema.Struct({ os: Schema.String, shell: Schema.String }),
  uses: Schema.Int,
  wins: Schema.Int,
  losses: Schema.Int,
  escalations: Schema.Int,
  version: Schema.Int,
  created: Schema.Finite,
  verified_at: Schema.Finite,
  expert: Schema.optionalKey(Schema.String),
  examples: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.String),
  pitfalls: Schema.Array(Schema.String),
  summaries: Schema.Array(Schema.String),
  trace: Schema.Array(Schema.Struct({ session_id: Schema.String, turn_id: Schema.String })),
})
export type Meta = typeof Meta.Type

const decodeMeta = Schema.decodeUnknownOption(Meta)

export interface Executed {
  readonly tool: string
  /** The shell command, or a short summary of another tool's input. */
  readonly summary: string
  readonly ok: boolean
  readonly output: string
}

export interface Turn {
  readonly sessionID: string
  readonly turnID: string
  readonly prompt: string
  readonly env: { readonly os: string; readonly shell: string }
  readonly expert?: string
  readonly summaries: ReadonlyArray<string>
  readonly executed: ReadonlyArray<Executed>
  readonly delegated: boolean
  readonly now: number
}

const MAX_EXAMPLES = 8
const MAX_PITFALLS = 12
const MATCH_THRESHOLD = 0.34

/** A new skill from a turn whose steps were verified by real tool output, or undefined when nothing ran. */
export function build(turn: Turn): Meta | undefined {
  const steps = verifiedSteps(turn.executed)
  if (steps.length === 0) return undefined
  const name = slug(`${turn.prompt} ${turn.env.os}`)
  return {
    id: name,
    name,
    description: describe(turn.prompt, turn.env, turn.summaries),
    status: "candidate",
    executor: "local",
    env: turn.env,
    uses: 0,
    wins: 0,
    losses: 0,
    escalations: turn.delegated ? 1 : 0,
    version: 1,
    created: turn.now,
    verified_at: turn.now,
    ...(turn.expert ? { expert: turn.expert } : {}),
    examples: [oneLine(turn.prompt, 160)],
    steps,
    pitfalls: pitfalls(turn.executed),
    summaries: turn.summaries.slice(-3),
    trace: [{ session_id: turn.sessionID, turn_id: turn.turnID }],
  }
}

/** Folds a newer verified run into an existing skill: its steps replace the old ones, the rest accumulates. */
export function merge(existing: Meta, next: Meta): Meta {
  return {
    ...existing,
    description: next.description,
    version: existing.version + 1,
    verified_at: next.verified_at,
    escalations: existing.escalations + next.escalations,
    steps: next.steps,
    examples: unique([...existing.examples, ...next.examples]).slice(-MAX_EXAMPLES),
    pitfalls: unique([...existing.pitfalls, ...next.pitfalls]).slice(-MAX_PITFALLS),
    summaries: unique([...existing.summaries, ...next.summaries]).slice(-3),
    trace: [...existing.trace, ...next.trace].slice(-20),
  }
}

export type Outcome = "win" | "loss" | "escalated"

/** Counts one use of a skill and moves its status and executor (see HYBRID_LLM_PLAN.md, sections 6.4 and 7.6). */
export function record(meta: Meta, outcome: Outcome, now: number): Meta {
  const wins = meta.wins + (outcome === "win" ? 1 : 0)
  const losses = meta.losses + (outcome === "win" ? 0 : 1)
  const escalations = meta.escalations + (outcome === "escalated" ? 1 : 0)
  const rate = wins / Math.max(1, wins + losses)
  const status = losses >= 3 && rate < 0.5 ? "retired" : wins >= 3 && rate >= 0.8 ? "trusted" : meta.status
  const executor = outcome === "win" ? "local" : escalations >= 2 ? "expert" : meta.executor
  return {
    ...meta,
    uses: meta.uses + 1,
    wins,
    losses,
    escalations,
    status,
    executor,
    verified_at: outcome === "win" ? now : meta.verified_at,
  }
}

/** The SKILL.md the model reads. */
export function markdown(meta: Meta) {
  return [
    "---",
    `name: ${meta.name}`,
    `description: ${JSON.stringify(meta.description)}`,
    "---",
    "",
    `# ${meta.name}`,
    "",
    `Learned from verified tool output (version ${meta.version}, ${meta.env.os} / ${meta.env.shell}, status ${meta.status}).`,
    ...(meta.executor === "expert"
      ? ["", "The local model failed this task repeatedly. Hand it to the expert or delegate agent instead of retrying."]
      : []),
    "",
    "## When to use",
    ...meta.examples.map((example) => `- "${example}"`),
    "",
    "## Steps",
    ...meta.steps.map((step, index) => `${index + 1}. ${step}`),
    ...(meta.pitfalls.length ? ["", "## Pitfalls", ...meta.pitfalls.map((item) => `- ${item}`)] : []),
    ...(meta.summaries.length ? ["", "## Expert notes", ...meta.summaries.map((item) => `- ${item}`)] : []),
    "",
  ].join("\n")
}

/** The best usable skill for a prompt in this environment, by word overlap with its name, description and examples. */
export function match(prompt: string, env: { readonly os: string }, skills: Iterable<Meta>) {
  const words = tokens(prompt)
  if (words.size === 0) return undefined
  const scored = Array.from(skills)
    .filter((skill) => skill.status !== "retired" && skill.env.os === env.os)
    .map((skill) => {
      const known = tokens([skill.name.replaceAll("-", " "), skill.description, ...skill.examples].join(" "))
      const overlap = Array.from(words).filter((word) => known.has(word)).length
      return { skill, score: overlap / words.size + (skill.status === "trusted" ? 0.05 : 0) }
    })
    .toSorted((a, b) => b.score - a.score)
  return {
    best: scored[0] && scored[0].score >= MATCH_THRESHOLD ? scored[0] : undefined,
    candidates: scored.slice(0, 3).map((item) => ({ id: item.skill.id, score: Number(item.score.toFixed(2)) })),
  }
}

export function slug(text: string) {
  const words = Array.from(tokens(text)).slice(0, 6)
  return (words.length ? words.join("-") : "learned-skill").slice(0, 60)
}

function verifiedSteps(executed: ReadonlyArray<Executed>) {
  return unique(executed.filter((item) => item.ok).map((item) => (item.tool === "shell" ? `\`${item.summary}\`` : `${item.tool}: ${item.summary}`)))
}

// Failed commands are pitfalls only when the turn later got past them, which is what the verified steps show.
function pitfalls(executed: ReadonlyArray<Executed>) {
  return unique(
    executed.flatMap((item, index) =>
      !item.ok && executed.slice(index + 1).some((later) => later.ok)
        ? [`\`${oneLine(item.summary, 120)}\` failed: ${oneLine(firstError(item.output), 160)}`]
        : [],
    ),
  ).slice(0, MAX_PITFALLS)
}

function describe(prompt: string, env: { readonly os: string; readonly shell: string }, summaries: ReadonlyArray<string>) {
  const summary = summaries.at(-1)
  return oneLine(
    `Use when asked to ${oneLine(prompt, 140)} on ${env.os} (${env.shell}).${summary ? ` ${summary}` : ""}`,
    300,
  )
}

function firstError(output: string) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /error|not found|denied|failed|cannot|unable/i.test(line)) ?? lines.at(-1) ?? "no output"
}

const STOP = new Set(
  "the and for with this that from into your you are was were have has had karo kar kare karna hai hain mein main mujhe please can how what using use make need want".split(
    " ",
  ),
)

function tokens(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9.+#]+/)
      .map((word) => word.replace(/^[.]+|[.]+$/g, ""))
      .filter((word) => word.length >= 3 && !STOP.has(word)),
  )
}

function unique(items: ReadonlyArray<string>) {
  return Array.from(new Set(items))
}

function oneLine(text: string, length: number) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

export const parseMeta = (value: unknown) => Option.getOrUndefined(decodeMeta(value))
