import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { mimes } from "hono/utils/mime"
import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import files from "virtual:server-files"
import { Optional } from "./comTypes/Optional"
import { Type } from "./struct/Type"
import { useProject } from "./youtubeArchive/state"

export function startServer() {
    const configText = Optional.pcall(() => readFileSync(join(useProject().path, "server.json"), "utf-8")).tryUnwrap()
    if (configText == null) return

    const config = Type.object({
        port: Type.number.as(Type.optional, () => 8080),
    }).deserialize(JSON.parse(configText))

    const app = new Hono()

    files[""] = files["index.html"]

    for (const [path, content] of Object.entries(files)) {
        app.get(path, async c => {
            return c.text(content, 200, {
                "Content-Type": mimes[extname(path || "index.html").slice(1)] ?? "text/plain",
            })
        })
    }

    serve({
        fetch: app.fetch,
        port: config.port,
    }, (info) => {
        // eslint-disable-next-line no-console
        console.log("\r\x1b[0mServer listening at:", info)
    })
}
