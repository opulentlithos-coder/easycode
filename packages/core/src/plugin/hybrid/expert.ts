export * as HybridExpert from "./expert.js"

import { Effect, Option, Schema } from "effect"
import EXPERT from "./expert.txt"
import REVIEW from "./review.txt"

export const Step = Schema.Struct({
  id: Schema.String,
  goal: Schema.String,
  command: Schema.optionalKey(Schema.String),
  verify: Schema.optionalKey(Schema.String),
  expect: Schema.optionalKey(Schema.String),
  on_fail: Schema.optionalKey(Schema.String),
})
export type Step = typeof Step.Type

export const Plan = Schema.Struct({
  summary: Schema.String,
  assumptions: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  steps: Schema.Array(Step),
  needs_user: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
})
export type Plan = typeof Plan.Type

export interface Environment {
  readonly os: string
  readonly arch: string
  readonly shell: string
  readonly cwd: string
}

export interface FailedStep {
  readonly id: string
  readonly command: string
  readonly output: string
}

/** The expert's judgement of a finished turn, from its real tool output. */
export const Review = Schema.Struct({
  verdict: Schema.Literals(["success", "partial", "failed"]),
  score: Schema.optionalKey(Schema.Finite),
  reason: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  lessons: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
})
export type Review = typeof Review.Type

export interface ReviewedStep {
  readonly actor: string
  /** The shell command, or a short summary of another tool's input, already redacted. */
  readonly summary: string
  readonly ok: boolean
  readonly output: string
}

const decodePlan = Schema.decodeUnknownOption(Schema.fromJsonString(Plan))
const decodeReview = Schema.decodeUnknownOption(Schema.fromJsonString(Review))
const REVIEW_STEPS = 40
const REVIEW_OUTPUT_LINES = 8
const MAX_LESSONS = 5

export function parse(text: string) {
  return Option.getOrUndefined(decodePlan(jsonObject(text)))
}

export function parseReview(text: string) {
  const review = Option.getOrUndefined(decodeReview(jsonObject(text)))
  return review && { ...review, lessons: review.lessons.filter((item) => item.trim().length > 0).slice(0, MAX_LESSONS) }
}

// Experts sometimes wrap the JSON in a code fence or add a sentence around it.
function jsonObject(text: string) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start === -1 || end < start ? "" : text.slice(start, end + 1)
}

export function reviewPrompt(input: {
  readonly environment: Environment
  readonly task: string
  readonly plans: ReadonlyArray<readonly [string, Plan]>
  readonly executed: ReadonlyArray<ReviewedStep>
}) {
  const steps = input.executed.slice(-REVIEW_STEPS)
  return render(REVIEW, {
    os: input.environment.os,
    arch: input.environment.arch,
    shell: input.environment.shell,
    cwd: input.environment.cwd,
    task: escape(input.task),
    plans: input.plans
      .map(([id, plan]) => `<plan id="${escape(id)}">\n${escape(JSON.stringify(plan))}\n</plan>\n`)
      .join(""),
    executed: [
      ...(input.executed.length > steps.length ? [`[${input.executed.length - steps.length} earlier steps omitted]`] : []),
      ...steps.map((step, index) =>
        [
          `${index + 1}. [${step.ok ? "ok" : "FAILED"}] (${step.actor}) ${escape(step.summary)}`,
          ...(step.output.trim() ? [escape(tail(step.output.trim(), REVIEW_OUTPUT_LINES)).replace(/^/gm, "   ")] : []),
        ].join("\n"),
      ),
    ].join("\n"),
  })
}

export function prompt(input: {
  readonly environment: Environment
  readonly question: string
  readonly context?: string
  readonly previous?: Plan
  readonly failed?: FailedStep
  readonly retry?: boolean
}) {
  return render(EXPERT, {
    os: input.environment.os,
    arch: input.environment.arch,
    shell: input.environment.shell,
    cwd: input.environment.cwd,
    followup: input.failed
      ? "- A step of your previous plan failed. Explain the likely cause in summary and return a corrected plan that starts from the failed step.\n"
      : "",
    question: escape(input.question),
    context: input.context ? `<context>\n${escape(input.context)}\n</context>\n` : "",
    previous: input.previous ? `<previous_plan>\n${escape(JSON.stringify(input.previous))}\n</previous_plan>\n` : "",
    failed: input.failed
      ? `<failed_step id="${escape(input.failed.id)}">\n<command>${escape(input.failed.command)}</command>\n<output>\n${escape(input.failed.output)}\n</output>\n</failed_step>\n`
      : "",
  }).concat(input.retry ? "\nYour previous reply was not valid JSON. Reply with the JSON object only." : "")
}

/** The plan as the session's model reads it: numbered steps it can execute one at a time. */
export function format(planID: string, plan: Plan) {
  return [
    `Expert plan ${planID}: ${plan.summary}`,
    ...(plan.assumptions.length ? ["Assumptions:", ...plan.assumptions.map((item) => `- ${item}`)] : []),
    "Steps:",
    ...plan.steps.flatMap((step, index) => [
      `${index + 1}. [${step.id}] ${step.goal}`,
      ...(step.command ? [`   command: ${step.command}`] : []),
      ...(step.verify ? [`   verify: ${step.verify}`] : []),
      ...(step.expect ? [`   expect: ${step.expect}`] : []),
      ...(step.on_fail ? [`   if it fails: ${step.on_fail}`] : []),
    ]),
    ...(plan.needs_user.length ? ["Needs the user:", ...plan.needs_user.map((item) => `- ${item}`)] : []),
    `Run each step yourself and check its verify output. If a step fails twice, call ask_expert with plan_id "${planID}" and failed_step.`,
  ].join("\n")
}

const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted key]"],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    "$1$2[redacted]",
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted email]"],
]

/** Removes common secrets and emails, and replaces the home directory, before text leaves this machine or is stored. */
export function redact(text: string, home?: string) {
  const masked = SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
  return home && home.length > 1 ? masked.split(home).join("~") : masked
}

/** The last `lines` lines, so a long command output keeps its error. */
export function tail(text: string, lines = 60) {
  const all = text.split(/\r?\n/)
  return all.length <= lines ? text : [`[${all.length - lines} earlier lines omitted]`, ...all.slice(-lines)].join("\n")
}

// One pass, so a value that contains a placeholder is not expanded again.
export function render(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
