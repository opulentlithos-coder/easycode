export * as HybridPlugin from "./hybrid.js"

import { Message, SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { Entry } from "@opencode/schema/config"
import type { ConfigModel } from "@opencode/schema/config/model"
import { Model } from "@opencode/schema/model"
import { Tool } from "@opencode/schema/tool"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { createHash } from "crypto"
import { Cause, Clock, Effect, Option, Schema, Stream } from "effect"
import os from "os"
import path from "path"
import { Config } from "../config.js"
import { Flag } from "../flag.js"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { HybridExpert } from "./hybrid/expert.js"
import { HybridLearned } from "./hybrid/learned.js"
import { HybridTrace } from "./hybrid/trace.js"
import LOCAL from "./hybrid/local.txt"

export const TOOL = "ask_expert"
const DAY = 24 * 60 * 60 * 1000
const CACHE_TTL = 30 * DAY
const CONTEXT_LIMIT = 4_000
const PLAN_PREFIX = "plan:"
const CACHE_PREFIX = "cache:"
const TRACE_PREFIX = "trace:"

const Input = Schema.Struct({
  question: Schema.String.annotate({
    description: "What you need to know, such as the task you can't do yet or the exact commands you are missing.",
  }),
  context: Schema.optionalKey(Schema.String).annotate({
    description: "Short relevant context: an error message, log excerpt or file snippet. Keep it under ~2000 characters.",
  }),
  plan_id: Schema.optionalKey(Schema.String).annotate({
    description: "The plan_id of an earlier expert plan, when asking a follow-up about it.",
  }),
  failed_step: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The id of the plan step that failed, such as s2." }),
      command: Schema.String.annotate({ description: "The command you ran." }),
      output: Schema.String.annotate({ description: "Its output, ideally the last lines with the error." }),
    }),
  ).annotate({ description: "The step of plan_id that failed, with the command and its output." }),
})

const StoredPlan = Schema.Struct({ plan: HybridExpert.Plan, question: Schema.String, at: Schema.Finite })
const decodeStoredPlan = Schema.decodeUnknownOption(StoredPlan)
const CachedAnswer = Schema.Struct({ planID: Schema.String, plan: HybridExpert.Plan, at: Schema.Finite })
const decodeCachedAnswer = Schema.decodeUnknownOption(CachedAnswer)

interface Turn {
  readonly id: string
  readonly prompt: string
  readonly started: number
  consults: number
  summaries: string[]
  plans: Map<string, HybridExpert.Plan>
  executed: Array<HybridLearned.Executed & { readonly actor: "local" | "expert" }>
  failures: Map<string, number>
  consecutive: number
  executedAtLastConsult: number
  reminder?: string
  skill?: string
  injected: boolean
  delegated: boolean
  finished: boolean
}

interface SessionState {
  consults: number
  turn?: Turn
  /** Set on a delegate subagent's session: its tool calls feed the parent's turn. */
  parent?: string
}

export const Plugin = define({
  id: "opencode.hybrid",
  effect: Effect.fn("HybridPlugin")(function* (ctx) {
    if (!(yield* Flag.enabled("hybrid_advisor"))) return
    const config = yield* Config.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const settings = config.entries().pipe(Effect.map((entries) => readSettings(entries, global.data)))
    const initial = yield* settings
    const trace = HybridTrace.make({ fs, directory: path.join(global.data, "hybrid", "traces"), home: global.home })
    yield* trace.prune(initial.retentionDays, yield* Clock.currentTimeMillis).pipe(Effect.forkScoped)

    const sessions = new Map<string, SessionState>()
    const levels = new Map<string, HybridTrace.Level>()
    const learned = new Map<string, HybridLearned.Meta>()
    // The shell the shell tool actually starts, once it has run; the platform default until then.
    let shell = defaultShell()

    const environment = (): HybridExpert.Environment => ({
      os: process.platform,
      arch: os.arch(),
      shell,
      cwd: ctx.location.directory,
    })
    const state = (sessionID: string) => {
      const existing = sessions.get(sessionID)
      if (existing) return existing
      const created: SessionState = { consults: 0 }
      sessions.set(sessionID, created)
      return created
    }
    const turnOf = (sessionID: string) => {
      const current = sessions.get(sessionID)
      return current?.parent ? sessions.get(current.parent)?.turn : current?.turn
    }

    // A session's own /hybrid-trace choice, then a delegate parent's, then OPENCODE_HYBRID_TRACE, then config.
    // Annotated because it recurses into a delegate's parent.
    const levelOf: (sessionID: string) => Effect.Effect<HybridTrace.Level> = Effect.fn("HybridPlugin.levelOf")(function* (
      sessionID: string,
    ) {
      const cached = levels.get(sessionID)
      if (cached) return cached
      const own = yield* ctx.storage.get(TRACE_PREFIX + sessionID)
      const parent = sessions.get(sessionID)?.parent
      const inherited = parent ? yield* levelOf(parent) : undefined
      const level = HybridTrace.resolve(
        own,
        inherited === "off" ? undefined : inherited,
        process.env.OPENCODE_HYBRID_TRACE,
        (yield* settings).trace,
      )
      levels.set(sessionID, level)
      return level
    })
    const emit = (event: HybridTrace.Event) =>
      levelOf(event.sessionID).pipe(
        Effect.flatMap((level) => trace.record(level, event)),
        Effect.catchCause((cause) => Effect.logWarning("failed to trace a hybrid event", { cause })),
      )

    yield* loadLearned(fs, initial.skillsDirectory).pipe(
      Effect.map((items) => items.forEach((meta) => learned.set(meta.id, meta))),
      Effect.catchCause((cause) => Effect.logWarning("failed to load learned skills", { cause })),
    )
    yield* ctx.skill.transform((editor) => {
      learned.forEach((meta) => {
        if (meta.status === "retired") return
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make(`learned-${meta.id}`),
            name: Skill.Name.make(meta.name),
            description: meta.description,
            path: AbsolutePath.make(path.join(initial.skillsDirectory, meta.id, "SKILL.md")),
            content: HybridLearned.markdown(meta),
          }),
        )
      })
    })

    const save = Effect.fn("HybridPlugin.save")(function* (meta: HybridLearned.Meta) {
      const directory = path.join(initial.skillsDirectory, meta.id)
      yield* fs.writeWithDirs(path.join(directory, "SKILL.md"), HybridLearned.markdown(meta))
      yield* fs.writeJson(path.join(directory, "hybrid.json"), meta)
      learned.set(meta.id, meta)
      yield* ctx.skill.reload()
      return path.join(directory, "SKILL.md")
    })

    yield* ctx.shell.hook("create.before", (event) =>
      Effect.sync(() => {
        shell = path.basename(event.shell).replace(/\.exe$/i, "")
      }),
    )

    // Turn start: a new user prompt resets the turn and looks for a learned skill.
    yield* ctx.session.hook("prompt", (event) =>
      Effect.gen(function* () {
        const current = yield* settings
        if (!current.expert) return
        const session = yield* ctx.session.get({ sessionID: event.sessionID })
        if (current.delegateAgent && session.agent === current.delegateAgent && session.parentID) {
          // The delegate works on the parent's turn, so its verified steps can become the parent's skill.
          state(event.sessionID).parent = session.parentID
          yield* emit({
            sessionID: session.parentID,
            turnID: turnOf(session.parentID)?.id,
            actor: "plugin",
            type: "delegate.session",
            data: { child_session_id: event.sessionID, agent: session.agent },
          })
          return
        }
        const env = environment()
        const found = HybridLearned.match(event.prompt.text, env, learned.values())
        const skill = found?.best?.skill
        const now = yield* Clock.currentTimeMillis
        state(event.sessionID).turn = {
          id: event.messageID,
          prompt: event.prompt.text,
          started: now,
          consults: 0,
          summaries: [],
          plans: new Map(),
          executed: [],
          failures: new Map(),
          consecutive: 0,
          executedAtLastConsult: 0,
          injected: false,
          delegated: false,
          finished: false,
          ...(skill ? { skill: skill.id } : {}),
          ...(skill?.executor === "expert" && current.delegateAgent
            ? {
                reminder: `The learned skill "${skill.name}" records that the local model could not finish this task. Hand it to the "${current.delegateAgent}" subagent with the subagent tool, including the skill's steps.`,
              }
            : {}),
        }
        const turnID = event.messageID
        yield* emit({
          sessionID: event.sessionID,
          turnID,
          actor: "user",
          type: "turn.started",
          data: { prompt: event.prompt.text, env, expert: modelName(current.expert) },
        })
        yield* emit({
          sessionID: event.sessionID,
          turnID,
          actor: "plugin",
          type: "skill.searched",
          data: { candidates: found?.candidates ?? [], chosen: skill?.id ?? null, os: env.os },
        })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("hybrid turn start failed", { cause }))),
    )

    // Every step: the consult rules and any learned skill for the session's model, plus a one-time reminder.
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const current = yield* settings
        if (!current.expert) return
        if (sameModel(event.model, current.expert) || event.agent === current.delegateAgent) {
          // The expert does the work itself here; it has nobody to ask.
          delete event.tools[TOOL]
          return
        }
        const turn = turnOf(event.sessionID)
        const skill = turn?.skill ? learned.get(turn.skill) : undefined
        event.system.push(
          SystemPart.make(
            [
              HybridExpert.render(LOCAL, {
                delegate: current.delegateAgent
                  ? `\n- If a task still fails after the expert's corrected steps, hand it to the "${current.delegateAgent}" subagent with the subagent tool. Give it the goal, the plan so far and the failing output.`
                  : "",
              }),
              ...(skill
                ? ["", `<learned_skill id="${skill.id}">`, HybridLearned.markdown(skill), "</learned_skill>"]
                : []),
            ].join("\n"),
          ),
        )
        if (!turn) return
        if (skill && !turn.injected) {
          turn.injected = true
          yield* emit({
            sessionID: event.sessionID,
            turnID: turn.id,
            actor: "plugin",
            type: "skill.injected",
            data: { skill_id: skill.id, version: skill.version, status: skill.status, executor: skill.executor },
          })
        }
        if (!turn.reminder) return
        // Not persisted: it reaches the model once, at the tail, where a small model notices it.
        const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
        event.messages.splice(at, 0, Message.user(turn.reminder))
        yield* emit({
          sessionID: event.sessionID,
          turnID: turn.id,
          actor: "plugin",
          type: "trigger.injected",
          data: { reminder: turn.reminder },
        })
        turn.reminder = undefined
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("hybrid context failed", { cause }))),
    )

    const ask = Effect.fn("HybridPlugin.ask")(function* (prompt: string, model: Model.Ref) {
      const result = yield* ctx.experimental.generate.text({ prompt, model }).pipe(
        Effect.mapError(
          (error) =>
            new Tool.Error({
              message: `The expert model ${model.providerID}/${model.id} failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            }),
        ),
      )
      return result.text
    })

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL,
        description:
          "Ask a larger expert model how to do something you are unsure about, before guessing. It cannot run anything: it returns a step-by-step plan with exact commands for this machine, verify commands and pitfalls, which you then execute yourself with your own tools. When a step of the plan fails, call it again with plan_id and failed_step.",
        input: Input,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const current = yield* settings
            if (!current.expert)
              return yield* new Tool.Error({ message: "No expert model is configured: set experimental.hybrid.expert." })
            const session = state(context.sessionID)
            const turn = turnOf(context.sessionID)
            const turnID = turn?.id ?? context.messageID
            if ((turn?.consults ?? 0) >= current.perTurn || session.consults >= current.perSession) {
              yield* emit({
                sessionID: context.sessionID,
                turnID,
                actor: "plugin",
                type: "budget.exceeded",
                data: { turn: turn?.consults ?? 0, session: session.consults, per_turn: current.perTurn, per_session: current.perSession },
              })
              return {
                content: `The expert consult budget is used up (${current.perTurn} per turn, ${current.perSession} per session). Continue with what you know, ${current.delegateAgent ? `hand the task to the "${current.delegateAgent}" subagent, ` : ""}or tell the user what is blocking you.`,
                metadata: { budget: "exceeded" },
              }
            }

            const env = environment()
            const question = HybridExpert.redact(input.question, global.home)
            const extra = input.context
              ? HybridExpert.redact(input.context, global.home).slice(0, CONTEXT_LIMIT)
              : undefined
            const previous = input.plan_id
              ? (turn?.plans.get(input.plan_id) ?? (yield* readPlan(input.plan_id)))
              : undefined
            const failed = input.failed_step
              ? {
                  id: input.failed_step.id,
                  command: HybridExpert.redact(input.failed_step.command, global.home),
                  output: HybridExpert.tail(HybridExpert.redact(input.failed_step.output, global.home)),
                }
              : undefined
            const model = Model.Ref.make({
              providerID: current.expert.providerID,
              id: current.expert.model,
              ...(current.expert.variant ? { variant: current.expert.variant } : {}),
            })
            const key =
              previous || failed
                ? undefined
                : createHash("sha256")
                    .update(JSON.stringify([question.trim().toLowerCase(), env.os, env.shell, model.providerID, model.id]))
                    .digest("hex")
                    .slice(0, 32)
            const started = yield* Clock.currentTimeMillis
            const cached = key ? yield* readCache(key, started) : undefined

            yield* emit({
              sessionID: context.sessionID,
              turnID,
              actor: "local",
              type: "expert.asked",
              data: {
                question,
                context: extra ?? null,
                plan_id: input.plan_id ?? null,
                failed_step: failed ?? null,
                follow_up: Boolean(previous || failed),
                cache_hit: Boolean(cached),
                env,
                budget_left: { turn: current.perTurn - (turn?.consults ?? 0) - 1, session: current.perSession - session.consults - 1 },
              },
            })

            const answered = cached
              ? { planID: cached.planID, plan: cached.plan, text: undefined, retried: false }
              : yield* Effect.gen(function* () {
                  const request = { environment: env, question, context: extra, previous, failed }
                  const first = yield* ask(HybridExpert.prompt(request), model)
                  const parsed = HybridExpert.parse(first)
                  if (parsed) return { planID: newPlanID(), plan: parsed, text: first, retried: false }
                  const second = yield* ask(HybridExpert.prompt({ ...request, retry: true }), model)
                  const reparsed = HybridExpert.parse(second)
                  return { planID: newPlanID(), plan: reparsed, text: second, retried: true }
                })
            const finished = yield* Clock.currentTimeMillis

            session.consults++
            if (turn) {
              turn.consults++
              turn.executedAtLastConsult = turn.executed.length
              turn.failures.clear()
              turn.consecutive = 0
              turn.reminder = undefined
              if (answered.plan) {
                turn.plans.set(answered.planID, answered.plan)
                turn.summaries.push(answered.plan.summary)
              }
            }
            if (answered.plan && !cached)
              yield* ctx.storage.set(PLAN_PREFIX + answered.planID, { plan: answered.plan, question, at: finished })
            if (answered.plan && key && !cached)
              yield* ctx.storage.set(CACHE_PREFIX + key, { planID: answered.planID, plan: answered.plan, at: finished })

            yield* emit({
              sessionID: context.sessionID,
              turnID,
              actor: "expert",
              type: "expert.answered",
              durationMs: finished - started,
              data: {
                plan_id: answered.planID,
                model: `${model.providerID}/${model.id}`,
                parse_ok: Boolean(answered.plan),
                retried: answered.retried,
                cached: Boolean(cached),
                steps: answered.plan?.steps.length ?? 0,
                summary: answered.plan?.summary ?? null,
                plan: answered.plan ?? null,
                text: answered.plan ? null : (answered.text ?? null),
              },
            })

            if (!answered.plan)
              return {
                content: `Expert answer (not structured; plan_id ${answered.planID}):\n${answered.text ?? ""}`,
                metadata: { plan_id: answered.planID, structured: false },
              }
            return {
              content: HybridExpert.format(answered.planID, answered.plan),
              metadata: { plan_id: answered.planID, cached: Boolean(cached), steps: answered.plan.steps.length },
            }
          }),
      })
    })

    const readPlan = Effect.fn("HybridPlugin.readPlan")(function* (planID: string) {
      return Option.getOrUndefined(decodeStoredPlan(yield* ctx.storage.get(PLAN_PREFIX + planID)))?.plan
    })
    const readCache = Effect.fn("HybridPlugin.readCache")(function* (key: string, now: number) {
      const cached = Option.getOrUndefined(decodeCachedAnswer(yield* ctx.storage.get(CACHE_PREFIX + key)))
      return cached && now - cached.at < CACHE_TTL ? cached : undefined
    })

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const current = yield* settings
        const delegate = delegateCall(event.input, current.delegateAgent)
        if (!delegate) return
        const turn = turnOf(event.sessionID)
        yield* emit({
          sessionID: event.sessionID,
          turnID: turn?.id,
          actor: "plugin",
          type: "delegate.started",
          data: { agent: delegate.agent, handoff: delegate.prompt },
        })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("hybrid delegate trace failed", { cause }))),
    )

    // Every tool result: the step log, failure counting, and the reminder to ask the expert or delegate.
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.tool === TOOL) return
        const current = yield* settings
        const turn = turnOf(event.sessionID)
        if (!turn || turn.finished) return
        const actor = sessions.get(event.sessionID)?.parent ? "expert" : "local"
        const command = commandOf(event.input)
        const tool = command === undefined ? event.tool : "shell"
        const summary = command ?? summarize(event.tool, event.input)
        const exitCode = event.status === "completed" ? exitCodeOf(event.result.output) : undefined
        const ok = event.status === "completed" && (exitCode === undefined || exitCode === null || exitCode === 0)
        const output = HybridExpert.tail(
          HybridExpert.redact(
            event.status === "completed" ? textOf(event.result.content) : event.error.message,
            global.home,
          ),
          30,
        )
        turn.executed.push({ tool, summary, ok, output, actor })
        yield* emit({
          sessionID: event.sessionID,
          turnID: turn.id,
          actor,
          type: "step.executed",
          data: { tool: event.tool, summary, ok, exit_code: exitCode ?? null, output },
        })

        const delegate = delegateCall(event.input, current.delegateAgent)
        if (delegate) {
          turn.delegated = true
          yield* emit({
            sessionID: event.sessionID,
            turnID: turn.id,
            actor: "expert",
            type: "delegate.finished",
            data: { agent: delegate.agent, ok, result: output },
          })
        }
        if (actor === "expert") return
        if (ok) {
          turn.consecutive = 0
          return
        }
        const failures = (turn.failures.get(summary) ?? 0) + 1
        turn.failures.set(summary, failures)
        turn.consecutive++
        if (failures < current.escalateAfter && turn.consecutive <= current.escalateAfter) return
        const exhausted = turn.consults >= current.perTurn
        const delegateNow = Boolean(current.delegateAgent) && (turn.consults >= 2 || exhausted)
        turn.reminder = delegateNow
          ? `This keeps failing even after the expert's steps. Stop retrying: hand the task to the "${current.delegateAgent}" subagent with the subagent tool. Give it the user's goal, the plan so far, what you changed, and this failing output:\n${output}`
          : exhausted
            ? `This keeps failing and the expert budget is used up. Stop retrying and tell the user what is blocking you, with this output:\n${output}`
            : `\`${summary}\` has failed ${failures} time(s). Don't try random fixes: call ask_expert${turn.plans.size ? " with plan_id and failed_step" : ""}, including this output:\n${output}`
        turn.failures.delete(summary)
        turn.consecutive = 0
        yield* emit({
          sessionID: event.sessionID,
          turnID: turn.id,
          actor: "plugin",
          type: "trigger.fired",
          data: {
            reason: failures >= current.escalateAfter ? "same_step_failed" : "consecutive_failures",
            step: summary,
            failures,
            action: delegateNow ? "delegate" : exhausted ? "ask_user" : "ask_expert",
          },
        })
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("hybrid step tracking failed", { cause }))),
    )

    // Turn end: record the outcome, then learn from a turn the expert or a delegate helped finish.
    yield* ctx.session.hook("experimental.idle", (event) =>
      Effect.gen(function* () {
        const current = yield* settings
        const owned = sessions.get(event.sessionID)
        const turn = owned?.turn
        if (!turn || turn.finished || owned?.parent) return
        // The Session's own background work wakes it again when it finishes; judge the turn then.
        if (event.background.some((work) => work.sessionID === event.sessionID)) return
        turn.finished = true
        const now = yield* Clock.currentTimeMillis
        const after = turn.executed.slice(turn.executedAtLastConsult)
        const success = (turn.executed.at(-1)?.ok ?? true) && (turn.consults === 0 || after.some((item) => item.ok))
        const helped = turn.consults > 0 || turn.delegated
        const handledBy = turn.delegated ? "delegate" : turn.consults > 0 ? "expert-advice" : turn.skill ? "skill" : "local"

        const built =
          current.learn && helped && success
            ? HybridLearned.build({
                sessionID: event.sessionID,
                turnID: turn.id,
                prompt: turn.prompt,
                env: { os: process.platform, shell },
                ...(current.expert ? { expert: modelName(current.expert) } : {}),
                summaries: turn.summaries,
                executed: turn.executed,
                delegated: turn.delegated,
                now,
              })
            : undefined
        const used = turn.skill ? learned.get(turn.skill) : undefined

        if (used) {
          const outcome = success && !helped ? "win" : turn.delegated ? "escalated" : "loss"
          const counted = HybridLearned.record(used, outcome, now)
          const next = built ? HybridLearned.merge(counted, { ...built, id: used.id, name: used.name }) : counted
          const file = yield* save(next)
          yield* emit({
            sessionID: event.sessionID,
            turnID: turn.id,
            actor: "skill",
            type: built ? "skill.merged" : "skill.lifecycle",
            data: {
              skill_id: next.id,
              path: file,
              outcome,
              status: { from: used.status, to: next.status },
              executor: { from: used.executor, to: next.executor },
              counters: { uses: next.uses, wins: next.wins, losses: next.losses, escalations: next.escalations },
              version: next.version,
              steps: built?.steps ?? [],
              pitfalls: built?.pitfalls ?? [],
            },
          })
        }
        if (!used && built) {
          const existing = learned.get(built.id)
          const next = existing ? HybridLearned.merge(existing, built) : built
          const file = yield* save(next)
          yield* emit({
            sessionID: event.sessionID,
            turnID: turn.id,
            actor: "skill",
            type: existing ? "skill.merged" : "skill.created",
            data: {
              skill_id: next.id,
              path: file,
              version: next.version,
              env: next.env,
              steps: built.steps,
              pitfalls: built.pitfalls,
              evidence: turn.executed.map((item) => ({ actor: item.actor, tool: item.tool, step: item.summary, ok: item.ok })),
              plans: Array.from(turn.plans.keys()),
            },
          })
        }

        yield* emit({
          sessionID: event.sessionID,
          turnID: turn.id,
          actor: "plugin",
          type: "turn.finished",
          durationMs: now - turn.started,
          data: {
            outcome: success ? "success" : "failed",
            handled_by: handledBy,
            consults: turn.consults,
            steps: turn.executed.length,
            failed_steps: turn.executed.filter((item) => !item.ok).length,
            skill_id: turn.skill ?? null,
            learned: built?.id ?? null,
          },
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning("hybrid turn end failed", { cause }),
        ),
      ),
    )

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "hybrid-trace",
        description: "trace the hybrid advisor for this session [off|basic|full]",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim().toLowerCase()
            const usage = `Usage: /hybrid-trace off|basic|full. Trace files: ${trace.directory}`
            if (text === "")
              return yield* Effect.fail(
                new Error(`Hybrid trace for this session: ${yield* levelOf(input.sessionID)}. ${usage}`),
              )
            if (!HybridTrace.isLevel(text)) return yield* Effect.fail(new Error(usage))
            yield* ctx.storage.set(TRACE_PREFIX + input.sessionID, text)
            levels.set(input.sessionID, text)
            yield* trace.record(text, {
              sessionID: input.sessionID,
              actor: "user",
              type: "trace.level",
              data: { level: text },
            })
          }),
      })
    })

    yield* ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          sessions.delete(event.data.sessionID)
          levels.delete(event.data.sessionID)
          yield* ctx.storage.remove(TRACE_PREFIX + event.data.sessionID)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to forget a hybrid session", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

export interface Settings {
  readonly expert?: ConfigModel.Selection
  readonly delegateAgent?: string
  readonly perTurn: number
  readonly perSession: number
  readonly escalateAfter: number
  readonly learn: boolean
  readonly skillsDirectory: string
  readonly trace?: HybridTrace.Level
  readonly retentionDays: number
}

/** Each field from the last config document that sets it, so a later document setting other fields doesn't hide it. */
export function readSettings(entries: ReadonlyArray<Entry>, data: string): Settings {
  const hybrid = entries.flatMap((entry) =>
    entry.type === "document" && entry.info.experimental?.hybrid ? [entry.info.experimental.hybrid] : [],
  )
  const last = <K extends keyof (typeof hybrid)[number]>(key: K) =>
    hybrid.findLast((item) => item[key] !== undefined)?.[key]
  const expert = last("expert")
  const delegateAgent = last("delegate_agent")
  const trace = last("trace")
  return {
    ...(expert ? { expert } : {}),
    ...(delegateAgent ? { delegateAgent } : {}),
    perTurn: last("max_consults_per_turn") ?? 3,
    perSession: last("max_consults_per_session") ?? 10,
    escalateAfter: last("escalate_after") ?? 2,
    learn: last("learn") ?? true,
    skillsDirectory: last("skills_directory") ?? path.join(data, "hybrid", "skills"),
    ...(trace ? { trace } : {}),
    retentionDays: last("trace_retention_days") ?? 30,
  }
}

const loadLearned = Effect.fn("HybridPlugin.loadLearned")(function* (fs: FSUtil.Interface, directory: string) {
  if (!(yield* fs.isDir(directory))) return []
  const files = yield* fs.scan("*/hybrid.json", { cwd: directory, absolute: true, include: "file" })
  const metas = yield* Effect.forEach(files, (file) =>
    fs.readJson(file).pipe(
      Effect.map(HybridLearned.parseMeta),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
  )
  return metas.filter((meta): meta is HybridLearned.Meta => meta !== undefined)
})

function sameModel(ref: Model.Ref, expert: NonNullable<Settings["expert"]>) {
  return ref.providerID === expert.providerID && ref.id === expert.model
}

function modelName(expert: NonNullable<Settings["expert"]>) {
  return `${expert.providerID}/${expert.model}`
}

function newPlanID() {
  return `pln_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`
}

function defaultShell() {
  if (process.platform === "win32") return "powershell"
  return path.basename(process.env.SHELL ?? "sh")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function commandOf(input: unknown) {
  return isRecord(input) && typeof input.command === "string" ? input.command : undefined
}

function delegateCall(input: unknown, agent: string | undefined) {
  if (!agent || !isRecord(input) || input.agent !== agent) return undefined
  return { agent, prompt: typeof input.prompt === "string" ? input.prompt : "" }
}

function exitCodeOf(output: unknown) {
  if (!isRecord(output)) return undefined
  return typeof output.exitCode === "number" || output.exitCode === null ? output.exitCode : undefined
}

// A short, stable description of a non-shell tool call: its first path- or pattern-like argument.
function summarize(tool: string, input: unknown) {
  if (!isRecord(input)) return tool
  const value = ["filePath", "path", "pattern", "url", "query", "agent", "id"]
    .map((key) => input[key])
    .find((item): item is string => typeof item === "string")
  return value ? `${tool} ${value}` : tool
}

function textOf(content: Tool.Result["content"]) {
  if (content === undefined) return ""
  if (typeof content === "string") return content
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}
