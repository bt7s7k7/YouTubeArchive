import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { mimes } from "hono/utils/mime"
import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import files from "virtual:server-files"
import { Optional } from "./comTypes/Optional"
import { iteratorNth } from "./comTypes/util"
import { Struct } from "./struct/Struct"
import { Type } from "./struct/Type"
import { Playlist } from "./youtubeArchive/Playlist"
import { useProject } from "./youtubeArchive/state"
// @ts-ignore
import ta from "time-ago"
import { DEFAULT_THUMBNAIL } from "./DEFAULT_THUMBNAIL"
import { VideoInfo } from "./youtubeArchive/VideoInfo"

export class VideoDisplay extends Struct.define("VideoDisplay", {
    id: Type.string.as(Type.nullable),
    label: Type.string,
    thumbnail: Type.string,
    captions: Type.string.as(Type.array).as(Type.nullable),
    channel: Type.string.as(Type.nullable),
    channelId: Type.string.as(Type.nullable),
    publishedAt: Type.string,
    publishedAgo: Type.string,
}) { }

export class PlaylistDisplay extends Struct.define("PlaylistDisplay", {
    id: Type.string.as(Type.nullable),
    label: Type.string,
    thumbnail: Type.string,
    url: Type.string.as(Type.nullable),
    size: Type.number,
}) { }

export function startServer() {
    const project = useProject()
    const configText = Optional.pcall(() => readFileSync(join(project.path, "server.json"), "utf-8")).tryUnwrap()
    if (configText == null) return null

    const config = Type.object({
        port: Type.number.as(Type.optional, () => 8080),
    }).deserialize(JSON.parse(configText))

    const app = new Hono()

    files[""] = files["index.html"]

    for (const [path, content] of Object.entries(files)) {
        app.get(path.endsWith(".html") ? path.slice(0, -5) : path, async c => {
            let templatedContent = content

            if (extname(path) == ".html" || path == "") {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const videoRegistry = await project.getVideoRegistry()

                let playlist: Playlist | undefined | null = null

                const playlistId = c.req.query("playlist")
                if (playlistId) {
                    playlist = playlistRegistry.playlists.find(v => v.id == playlistId)
                    if (playlist == null) return c.notFound()
                }

                let video: VideoInfo | undefined | null = null
                const videoId = c.req.query("v")
                if (templatedContent.includes("$$VIDEO$$")) {
                    if (videoId == null) return c.notFound()
                    video = videoRegistry.videos.get(videoId)
                    if (video == null) return c.notFound()
                }

                templatedContent = templatedContent
                    .replace(/\$\$LIST\$\$/, () => (
                        JSON.stringify([
                            new PlaylistDisplay({
                                label: "All Videos",
                                size: videoRegistry.videos.size,
                                thumbnail: Optional.pcall(() => iteratorNth(videoRegistry.videos.values()).thumbnail).tryUnwrap() ?? DEFAULT_THUMBNAIL,
                            }).serialize(),
                            ...playlistRegistry.playlists.map(playlist => new PlaylistDisplay({
                                id: playlist.id, label: playlist.label, url: playlist.url,
                                size: playlist.videos.length,
                                thumbnail: playlist.videos.at(0)?.thumbnail ?? DEFAULT_THUMBNAIL,
                            }).serialize()),
                        ])
                    ))
                    .replace(/\$\$VIDEOS\$\$/, () => (
                        JSON.stringify({
                            label: playlist?.label ?? "All Videos",
                            url: playlist?.url,
                            videos: (playlist?.videos ?? [...videoRegistry.videos.values()]).map(video => new VideoDisplay({
                                id: video.file == null ? null : video.id,
                                label: video.label,
                                channel: video.channel, channelId: video.channelId,
                                thumbnail: video.thumbnail ?? DEFAULT_THUMBNAIL,
                                captions: video.getCaptionsList(),
                                publishedAt: video.publishedAt,
                                publishedAgo: ta.ago(video.publishedAt),
                            })),
                        })
                    ))
                    .replace(/\$\$VIDEO\$\$/, () => (
                        JSON.stringify({
                            ...video!.serialize(),
                            publishedAgo: ta.ago(video!.publishedAt),
                        })
                    ))
            }

            return c.text(templatedContent, 200, {
                "Content-Type": mimes[extname(path || "index.html").slice(1)] ?? "text/plain",
            })
        })
    }

    app.use("*", serveStatic({
        root: join(project.path, "videos"),
    }))

    return serve({
        fetch: app.fetch,
        port: config.port,
    }, (info) => {
        // eslint-disable-next-line no-console
        console.log("\r\x1b[0mServer listening at:", info)
    })
}
