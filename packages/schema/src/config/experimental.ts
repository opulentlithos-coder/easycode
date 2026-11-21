export * as ConfigExperimental from "./experimental.js"

import { Record, Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "../schema.js"
import { ConfigFlag } from "./flag.js"
import { ConfigModel } from "./model.js"
import { ConfigPolicy } from "./policy.js"

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  portable_shell_scanner: Schema.Boolean.pipe(optional).annotate({
    description: "Deprecated: the built-in shell permission scanner is now always enabled.",
  }),
  codemode_vm: Schema.Boolean.pipe(optional).annotate({
    description: "Deprecated: ignored because Code Mode always runs on the VM.",
  }),
  all_flags: Schema.Boolean.pipe(optional).annotate({
    description:
      "Enable all flags except opt-in-only flags on any build channel, like OPENCODE_FLAGS=all. Per-flag config settings take precedence over all_flags; false leaves the build defaults in effect.",
  }),
  ...Record.map(ConfigFlag.registry, (description, key) =>
    Schema.Boolean.pipe(optional).annotate({
      description: ConfigFlag.optInOnly.has(key)
        ? description
        : `${description} Defaults to on in local and dev builds and off in releases.`,
    }),
  ),
  // The flag also takes settings; an object turns it on.
  video_generate: Schema.Union([
    Schema.Boolean,
    Schema.Struct({
      model: ConfigModel.Selection.pipe(optional).annotate({
        description:
          "Default model for the experimental_video_generate tool when the agent doesn't choose one, as providerID/modelID. Falls back to automatic selection when it isn't available.",
      }),
    }),
  ])
    .pipe(optional)
    .annotate({
      description: `${ConfigFlag.registry.video_generate} Defaults to on in local and dev builds and off in releases. An object turns it on and sets the tool's options.`,
    }),
  part_rows: Schema.Boolean.pipe(optional).annotate({
    description:
      "Write each assistant part as its own session_part row instead of rewriting the whole message on every event. Defaults to true; set false to fall back to whole-message writes.",
  }),
  image_generate: Schema.Union([
    Schema.Boolean,
    Schema.Struct({
      model: ConfigModel.Selection.pipe(optional).annotate({
        description:
          "Default model for the experimental_image_generate tool when the agent doesn't choose one, as providerID/modelID. Falls back to automatic selection when it isn't available.",
      }),
    }),
  ])
    .pipe(optional)
    .annotate({
      description:
        "Settings for the experimental_image_generate tool, which is offered while a connected provider has an image model.",
    }),
  hybrid: Schema.Struct({
    expert: ConfigModel.Selection.pipe(optional).annotate({
      description:
        "Model the session's model consults through the ask_expert tool, as providerID/modelID. Required for the tool to be offered.",
    }),
    delegate_agent: Schema.String.pipe(optional).annotate({
      description:
        "Subagent the session's model is told to hand a task to when it still fails after the expert's steps, such as an agent configured with the expert model and normal tools.",
    }),
    max_consults_per_turn: PositiveInt.pipe(optional).annotate({
      description: "Most ask_expert calls a single user turn may make. Defaults to 3.",
    }),
    max_consults_per_session: PositiveInt.pipe(optional).annotate({
      description: "Most ask_expert calls a session may make. Defaults to 10.",
    }),
    escalate_after: PositiveInt.pipe(optional).annotate({
      description:
        "Failed tool calls of the same command, or consecutive failed tool calls, before the model is reminded to ask the expert or delegate. Defaults to 2.",
    }),
    learn: Schema.Boolean.pipe(optional).annotate({
      description: "Save the verified steps of a turn that consulted the expert as a learned skill. Defaults to true.",
    }),
    skills_directory: Schema.String.pipe(optional).annotate({
      description: "Directory for learned skills, one <name>/SKILL.md each. Defaults to <config>/skills/learned.",
    }),
    review: Schema.Literals(["off", "consulted", "always"])
      .pipe(optional)
      .annotate({
        description:
          'When the expert reviews a finished turn from its real tool output: "consulted" after turns that asked it or delegated, "always" after every turn that ran tools, "off" never. Its verdict decides whether the turn counts as a success, and its lessons are added to the learned skill. Defaults to "consulted".',
      }),
    human_feedback: Schema.Literals(["off", "manual", "learned", "always"])
      .pipe(optional)
      .annotate({
        description:
          'How the user rates a turn: "manual" only with the /hybrid-feedback command, "learned" also asks after a turn that created, updated or used a learned skill, "always" also asks after every turn the expert, a delegate or a skill helped, "off" turns feedback off. Ratings move a skill between candidate, trusted and retired. Defaults to "manual".',
      }),
    trace: Schema.Literals(["off", "basic", "full"])
      .pipe(optional)
      .annotate({
        description:
          'Default trace level for hybrid runs: "basic" records every event with text previews, "full" records full (redacted) questions, answers and outputs. OPENCODE_HYBRID_TRACE and the /hybrid-trace command override it. Defaults to "off".',
      }),
    trace_retention_days: PositiveInt.pipe(optional).annotate({
      description: "Days to keep hybrid trace files. Defaults to 30.",
    }),
  })
    .pipe(optional)
    .annotate({
      description: `Settings for the hybrid advisor (flag hybrid_advisor): ${ConfigFlag.registry.hybrid_advisor}`,
    }),
  subagent_depth: NonNegativeInt.pipe(optional).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1.",
  }),
  location_idle_timeout: Schema.Union([Schema.DurationFromString, Schema.Literal(false)])
    .pipe(optional)
    .annotate({
      description:
        'How long a location can go without session activity before its services are unloaded. Running sessions and background jobs keep a location loaded. Set to false to never unload (default: "60 minutes")',
    }),
  policies: ConfigPolicy.Info.pipe(Schema.Array, optional).annotate({
    description: "Deprecated: use top-level policies. Ordered policies controlling access to configured resources",
  }),
}) {}
