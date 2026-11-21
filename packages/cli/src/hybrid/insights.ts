import { Option, Schema } from "effect"

/** One line of a hybrid trace file, as the core hybrid plugin writes it. */
const Event = Schema.Struct({
  v: Schema.Literal(1),
  at: Schema.String,
  seq: Schema.Int,
  level: Schema.String,
  session_id: Schema.String,
  turn_id: Schema.optionalKey(Schema.String),
  actor: Schema.String,
  type: Schema.String,
  duration_ms: Schema.optionalKey(Schema.Number),
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export type Event = typeof Event.Type

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

/** Trace events from one file's text; lines that aren't trace events are skipped. */
export function parse(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => Option.toArray(decodeEvent(line)))
}

export interface TimelineEntry {
  readonly seq: number
  readonly at: string
  readonly actor: string
  readonly type: string
  readonly text: string
  readonly ok?: boolean
  readonly data: Record<string, unknown>
}

export interface Turn {
  readonly sessionID: string
  readonly turnID: string
  readonly started: string
  readonly prompt: string
  readonly outcome?: string
  readonly handledBy?: string
  readonly consults: number
  readonly durationMs?: number
  readonly learned?: string
  readonly timeline: ReadonlyArray<TimelineEntry>
}

export interface Consult {
  readonly sessionID: string
  readonly turnID?: string
  readonly at: string
  readonly question: string
  readonly followUp: boolean
  readonly cacheHit: boolean
  readonly failedStep?: unknown
  readonly planID?: string
  readonly model?: string
  readonly summary?: string
  readonly steps?: unknown
  readonly text?: string
  readonly durationMs?: number
  readonly parsed?: boolean
}

export interface Failure {
  readonly step: string
  readonly count: number
  readonly lastOutput: string
  readonly lastAt: string
}

export interface SkillHistory {
  readonly id: string
  readonly path?: string
  readonly events: ReadonlyArray<{
    readonly at: string
    readonly type: string
    readonly sessionID: string
    readonly turnID?: string
    readonly data: Record<string, unknown>
  }>
}

export interface Summary {
  readonly sessions: number
  readonly turns: ReadonlyArray<Turn>
  readonly kpis: {
    readonly finished: number
    readonly successRate?: number
    readonly consultsPerTurn?: number
    readonly skillHitRate?: number
    readonly delegateRate?: number
    readonly handledBy: Record<string, number>
    readonly consults: number
    readonly cacheHits: number
    readonly expertMs: number
    readonly learned: number
    readonly triggers: number
  }
  readonly daily: ReadonlyArray<{ readonly day: string; readonly handledBy: Record<string, number> }>
  readonly consults: ReadonlyArray<Consult>
  readonly failures: ReadonlyArray<Failure>
  readonly skills: ReadonlyArray<SkillHistory>
}

export function summarize(events: ReadonlyArray<Event>): Summary {
  const ordered = events.toSorted((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq)
  const turns = turnsOf(ordered)
  const finished = turns.filter((turn) => turn.outcome !== undefined)
  const handledBy = count(finished.map((turn) => turn.handledBy ?? "unknown"))
  const consults = consultsOf(ordered)
  const rate = (value: number) => (finished.length === 0 ? undefined : value / finished.length)
  return {
    sessions: new Set(ordered.map((event) => event.session_id)).size,
    turns,
    kpis: {
      finished: finished.length,
      successRate: rate(finished.filter((turn) => turn.outcome === "success").length),
      consultsPerTurn: rate(finished.reduce((total, turn) => total + turn.consults, 0)),
      skillHitRate: rate(handledBy.skill ?? 0),
      delegateRate: rate(handledBy.delegate ?? 0),
      handledBy,
      consults: consults.length,
      cacheHits: consults.filter((item) => item.cacheHit).length,
      expertMs: consults.reduce((total, item) => total + (item.durationMs ?? 0), 0),
      learned: ordered.filter((event) => event.type === "skill.created").length,
      triggers: ordered.filter((event) => event.type === "trigger.fired").length,
    },
    daily: Object.entries(
      finished.reduce<Record<string, string[]>>((days, turn) => {
        const day = turn.started.slice(0, 10)
        return { ...days, [day]: [...(days[day] ?? []), turn.handledBy ?? "unknown"] }
      }, {}),
    )
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([day, items]) => ({ day, handledBy: count(items) })),
    consults,
    failures: failuresOf(ordered),
    skills: skillsOf(ordered),
  }
}

/** One line per event for a timeline, in the words the dashboard and report show. */
export function describe(event: Event): string {
  const data = event.data
  switch (event.type) {
    case "turn.started":
      return `"${oneLine(text(data.prompt), 160)}"`
    case "skill.searched":
      return text(data.chosen) ? `learned skill matched: ${text(data.chosen)}` : "no learned skill matched"
    case "skill.injected":
      return `using skill ${text(data.skill_id)} (v${text(data.version)}, ${text(data.status)})`
    case "expert.asked":
      return `${data.follow_up === true ? "follow-up to expert" : "asked expert"}${data.cache_hit === true ? " (cached)" : ""}: "${oneLine(text(data.question), 140)}"`
    case "expert.answered":
      return data.parse_ok === true
        ? `plan ${text(data.plan_id)}: ${text(data.steps)} steps · ${oneLine(text(data.summary), 120)}`
        : `unstructured answer (${text(data.plan_id)})`
    case "step.executed":
      return `${data.ok === true ? "✓" : "✗"} ${oneLine(text(data.summary), 140)}${typeof data.exit_code === "number" && data.exit_code !== 0 ? ` (exit ${data.exit_code})` : ""}`
    case "trigger.fired":
      return `trigger: ${text(data.reason)} on "${oneLine(text(data.step), 80)}" → ${text(data.action)}`
    case "trigger.injected":
      return "reminder sent to the model"
    case "budget.exceeded":
      return `expert budget used up (turn ${text(data.turn)}/${text(data.per_turn)}, session ${text(data.session)}/${text(data.per_session)})`
    case "delegate.started":
      return `handed to ${text(data.agent)}: "${oneLine(text(data.handoff), 120)}"`
    case "delegate.session":
      return `delegate session ${text(data.child_session_id)} started`
    case "delegate.finished":
      return `${text(data.agent)} finished (${data.ok === true ? "ok" : "failed"})`
    case "skill.created":
      return `learned new skill ${text(data.skill_id)} (v${text(data.version)}, ${Array.isArray(data.steps) ? data.steps.length : 0} steps)`
    case "skill.merged":
      return `updated skill ${text(data.skill_id)} to v${text(data.version)}`
    case "skill.lifecycle":
      return `skill ${text(data.skill_id)}: ${text(data.outcome)}`
    case "turn.finished":
      return `finished: ${text(data.outcome)}, handled by ${text(data.handled_by)}, ${text(data.consults)} consult(s)`
    case "trace.level":
      return `trace level set to ${text(data.level)}`
    default:
      return event.type
  }
}

function turnsOf(events: ReadonlyArray<Event>): Turn[] {
  const groups = events.reduce((map, event) => {
    if (!event.turn_id) return map
    const key = `${event.session_id}\u0000${event.turn_id}`
    map.set(key, [...(map.get(key) ?? []), event])
    return map
  }, new Map<string, Event[]>())
  return Array.from(groups.values())
    .map((items) => {
      const first = items[0]!
      const started = items.find((event) => event.type === "turn.started")
      const finished = items.findLast((event) => event.type === "turn.finished")
      return {
        sessionID: first.session_id,
        turnID: first.turn_id ?? "",
        started: (started ?? first).at,
        prompt: text(started?.data.prompt),
        ...(finished
          ? {
              outcome: text(finished.data.outcome),
              handledBy: text(finished.data.handled_by),
              ...(finished.duration_ms === undefined ? {} : { durationMs: finished.duration_ms }),
              ...(text(finished.data.learned) ? { learned: text(finished.data.learned) } : {}),
            }
          : {}),
        consults: items.filter((event) => event.type === "expert.asked" && event.data.cache_hit !== true).length,
        timeline: items.map((event) => ({
          seq: event.seq,
          at: event.at,
          actor: event.actor,
          type: event.type,
          text: describe(event),
          ...(event.type === "step.executed" ? { ok: event.data.ok === true } : {}),
          data: event.data,
        })),
      }
    })
    .toSorted((a, b) => b.started.localeCompare(a.started))
}

// Each question pairs with the next answer in its session; the tool asks and answers one at a time.
function consultsOf(events: ReadonlyArray<Event>): Consult[] {
  return events.flatMap((event, index) => {
    if (event.type !== "expert.asked") return []
    const answer = events
      .slice(index + 1)
      .find((later) => later.session_id === event.session_id && later.type === "expert.answered")
    return [
      {
        sessionID: event.session_id,
        ...(event.turn_id ? { turnID: event.turn_id } : {}),
        at: event.at,
        question: text(event.data.question),
        followUp: event.data.follow_up === true,
        cacheHit: event.data.cache_hit === true,
        ...(event.data.failed_step ? { failedStep: event.data.failed_step } : {}),
        ...(answer
          ? {
              planID: text(answer.data.plan_id),
              model: text(answer.data.model),
              summary: text(answer.data.summary),
              steps: isRecord(answer.data.plan) ? answer.data.plan.steps : undefined,
              text: text(answer.data.text),
              parsed: answer.data.parse_ok === true,
              ...(answer.duration_ms === undefined ? {} : { durationMs: answer.duration_ms }),
            }
          : {}),
      },
    ]
  })
}

function failuresOf(events: ReadonlyArray<Event>): Failure[] {
  const failed = events.filter((event) => event.type === "step.executed" && event.data.ok === false)
  const grouped = failed.reduce((map, event) => {
    const step = oneLine(text(event.data.summary), 160)
    const current = map.get(step)
    map.set(step, { step, count: (current?.count ?? 0) + 1, lastOutput: text(event.data.output), lastAt: event.at })
    return map
  }, new Map<string, Failure>())
  return Array.from(grouped.values()).toSorted((a, b) => b.count - a.count)
}

function skillsOf(events: ReadonlyArray<Event>): SkillHistory[] {
  const grouped = events
    .filter((event) => event.type.startsWith("skill.") && text(event.data.skill_id))
    .reduce((map, event) => {
      const id = text(event.data.skill_id)
      const current = map.get(id)
      map.set(id, {
        id,
        ...(text(event.data.path) ? { path: text(event.data.path) } : current?.path ? { path: current.path } : {}),
        events: [
          ...(current?.events ?? []),
          {
            at: event.at,
            type: event.type,
            sessionID: event.session_id,
            ...(event.turn_id ? { turnID: event.turn_id } : {}),
            data: event.data,
          },
        ],
      })
      return map
    }, new Map<string, SkillHistory>())
  return Array.from(grouped.values()).toSorted((a, b) => (b.events.at(-1)?.at ?? "").localeCompare(a.events.at(-1)?.at ?? ""))
}

function count(items: ReadonlyArray<string>) {
  return items.reduce<Record<string, number>>((totals, item) => ({ ...totals, [item]: (totals[item] ?? 0) + 1 }), {})
}

function text(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function oneLine(value: string, length: number) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

export * as HybridInsights from "./insights"
