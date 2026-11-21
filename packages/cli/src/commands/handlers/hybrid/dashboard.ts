import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { HybridInsights } from "../../../hybrid/insights"
import { HybridRender } from "../../../hybrid/render"
import { Runtime } from "../../../framework/runtime"
import { openUrl } from "../../../ui/prompt"
import { Commands } from "../../commands"

export default Runtime.handler(Commands.commands.hybrid.commands.dashboard, (input) =>
  Effect.gen(function* () {
    const directories = HybridRender.directories()
    const summary = HybridInsights.summarize(yield* HybridRender.load(directories.traces))
    const file = path.resolve(Option.getOrUndefined(input.out) ?? path.join(directories.root, "dashboard.html"))
    const html = HybridRender.dashboard(summary, { generated: new Date().toISOString(), directory: directories.traces })
    yield* Effect.tryPromise(() => Bun.write(file, html))
    process.stdout.write(`Hybrid dashboard: ${file} (${summary.kpis.finished} finished turn(s))${EOL}`)
    if (input.open) yield* openUrl(pathToFileURL(file).href)
  }),
)
