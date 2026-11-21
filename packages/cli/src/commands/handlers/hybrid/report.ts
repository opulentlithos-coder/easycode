import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { HybridInsights } from "../../../hybrid/insights"
import { HybridRender } from "../../../hybrid/render"
import { Runtime } from "../../../framework/runtime"
import { Commands } from "../../commands"

export default Runtime.handler(Commands.commands.hybrid.commands.report, (input) =>
  Effect.gen(function* () {
    const directory = HybridRender.directories().traces
    const summary = HybridInsights.summarize(yield* HybridRender.load(directory))
    const session = Option.getOrUndefined(input.session) ?? summary.turns[0]?.sessionID
    const turns = summary.turns.filter((turn) => turn.sessionID === session).slice(0, input.turns)
    process.stdout.write(HybridRender.report(summary, { turns, directory }) + EOL)
  }),
)
