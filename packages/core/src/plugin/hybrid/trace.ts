export * as HybridTrace from "./trace.js"

import { Clock, Effect, FileSystem, Option, Semaphore } from "effect"
import path from "path"
import { HybridExpert } from "./expert.js"

export const Levels = ["off", "basic", "full"] as const
export type Level = (typeof Levels)[number]

export type Actor = "user" | "local" | "expert" | "plugin" | "skill"

export interface Event {
  readonly sessionID: string
  readonly turnID?: string
  readonly actor: Actor
  readonly type: string
  readonly durationMs?: number
  readonly data: Record<string, unknown>
}

const PREVIEW = 200
const DAY = 24 * 60 * 60 * 1000

export const isLevel = (value: unknown): value is Level => Levels.some((level) => level === value)

/** The first set level wins: a session's own choice, then OPENCODE_HYBRID_TRACE, then config. */
export function resolve(...levels: ReadonlyArray<unknown>): Level {
  return levels.find(isLevel) ?? "off"
}

/**
 * Appends one JSON line per event to `<directory>/<sessionID>.jsonl`. `basic` keeps text previews, `full` keeps the
 * whole text; both are redacted first. Writes are serialized so each file stays in event order, and failures only log.
 */
export function make(input: { readonly fs: FileSystem.FileSystem; readonly directory: string; readonly home: string }) {
  const lock = Semaphore.makeUnsafe(1)
  const seq = new Map<string, number>()
  let ready = false

  const record = (level: Level, event: Event) => {
    if (level === "off") return Effect.void
    // Numbered before the write is queued, so the file order is the order events happened in.
    const next = (seq.get(event.sessionID) ?? 0) + 1
    seq.set(event.sessionID, next)
    return Effect.gen(function* () {
      const line = JSON.stringify({
        v: 1,
        at: new Date(yield* Clock.currentTimeMillis).toISOString(),
        seq: next,
        level,
        session_id: event.sessionID,
        ...(event.turnID ? { turn_id: event.turnID } : {}),
        actor: event.actor,
        type: event.type,
        ...(event.durationMs === undefined ? {} : { duration_ms: event.durationMs }),
        data: shape(level, event.data, input.home),
      })
      if (!ready) {
        yield* input.fs.makeDirectory(input.directory, { recursive: true })
        ready = true
      }
      yield* input.fs.writeFileString(path.join(input.directory, `${safe(event.sessionID)}.jsonl`), `${line}\n`, {
        flag: "a",
      })
    }).pipe(
      lock.withPermits(1),
      Effect.catchCause((cause) => Effect.logWarning("failed to write a hybrid trace event", { cause })),
    )
  }

  /** Removes trace files not written to in `days` days. */
  const prune = (days: number, now: number) =>
    Effect.gen(function* () {
      if (!(yield* input.fs.exists(input.directory))) return
      const files = yield* input.fs.readDirectory(input.directory)
      yield* Effect.forEach(
        files.filter((file) => file.endsWith(".jsonl")),
        (file) =>
          Effect.gen(function* () {
            const target = path.join(input.directory, file)
            const modified = Option.getOrUndefined((yield* input.fs.stat(target)).mtime)
            if (modified && now - modified.getTime() > days * DAY) yield* input.fs.remove(target)
          }),
        { discard: true },
      )
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to prune hybrid traces", { cause })))

  return { record, prune, directory: input.directory }
}

export type Recorder = ReturnType<typeof make>

/** Redacts every string, and at `basic` cuts long strings to a preview that still says how long they were. */
export function shape(level: Level, value: unknown, home: string): unknown {
  if (typeof value === "string") {
    const text = HybridExpert.redact(value, home)
    return level === "basic" && text.length > PREVIEW ? `${text.slice(0, PREVIEW)}… [${text.length} chars]` : text
  }
  if (Array.isArray(value)) return value.map((item) => shape(level, item, home))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(level, item, home)]))
  return value
}

function safe(name: string) {
  return name.replace(/[^A-Za-z0-9_-]/g, "_")
}
