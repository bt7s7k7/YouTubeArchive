import { serve } from "@hono/node-server"
import { getConnInfo } from "@hono/node-server/conninfo"
import { serveStatic } from "@hono/node-server/serve-static"
import { Context, Hono } from "hono"
import { mimes } from "hono/utils/mime"
import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import files from "virtual:server-files"
import { Optional } from "./comTypes/Optional"
import { fromBase64Binary, iteratorNth, unreachable } from "./comTypes/util"
import { Struct } from "./struct/Struct"
import { Type } from "./struct/Type"
import { Playlist } from "./youtubeArchive/Playlist"
import { useProject } from "./youtubeArchive/state"
// @ts-ignore
import ta from "time-ago"
import { DEFAULT_THUMBNAIL } from "./DEFAULT_THUMBNAIL"
import { UserError } from "./youtubeArchive/UserError"
import { VideoInfo } from "./youtubeArchive/VideoInfo"

export class VideoDisplay extends Struct.define("VideoDisplay", {
    id: Type.string,
    missing: Type.boolean,
    url: Type.string,
    label: Type.string,
    thumbnail: Type.string,
    captions: Type.string.as(Type.array).as(Type.nullable),
    channel: Type.string.as(Type.nullable),
    channelUrl: Type.string.as(Type.nullable),
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

    function isLocal(c: Context) {
        const info = getConnInfo(c)
        return info.remote.address == "::1"
    }

    files[""] = files["index.html"]

    app.get("/api/thumbnail/:id", async c => {
        const id = c.req.param("id")
        const videoRegistry = await project.getVideoRegistry()
        const video = videoRegistry.videos.get(id)

        if (video?.thumbnail) {
            const mime = video.thumbnail.slice(5, video.thumbnail.indexOf(";"))
            return c.body(fromBase64Binary(video.thumbnail.slice(video.thumbnail.indexOf(",") + 1)), 200, {
                "Content-Type": mime,
            })
        } else {
            return c.body(fromBase64Binary(DEFAULT_THUMBNAIL.slice(DEFAULT_THUMBNAIL.indexOf(",") + 1)), 404, {
                "Content-Type": "image/png",
            })
        }
    })

    function getPlaylistData(playlist: Playlist | undefined | null) {
        const videoRegistry = project["_videoRegistry"] ?? unreachable()

        return {
            id: playlist?.id ?? null,
            label: playlist?.label ?? "All Videos",
            url: playlist?.sourceId,
            labels: playlist == null ? [] : [...playlist.labels.entries()],
            videos: (playlist?.videos ?? [...videoRegistry.videos.values()]).map(video => new VideoDisplay({
                id: video.id,
                missing: video.file == null,
                url: video.getUrl(),
                label: video.label,
                channel: video.channel,
                channelUrl: video.getChannelUrl(),
                thumbnail: getThumbnailUrl(video),
                captions: video.getCaptionsList(),
                publishedAt: video.publishedAt,
                publishedAgo: ta.ago(video.publishedAt),
            })),
        }
    }

    app.put("/api/playlist/:playlist/video/:id/at/:anchor", async c => {
        if (!isLocal(c)) return c.text("Forbidden", 403)

        try {
            const playlistId = c.req.param("playlist")
            const videoId = c.req.param("id")

            const playlistRegistry = await project.getPlaylistRegistry()
            const playlist = playlistRegistry.playlists.find(v => v.id == playlistId)

            if (playlist == null) {
                throw new UserError("Playlist with the specified ID does not exist")
            }

            const videoRegistry = await project.getVideoRegistry()
            const video = videoRegistry.videos.get(videoId)

            if (video == null) {
                throw new UserError("Video with the specified ID does not exist")
            }

            const anchor = c.req.param("anchor")

            playlistRegistry.insertVideoOrChangeIndexInPlaylist(video, playlist, anchor == "first" || anchor == "last" ? anchor : { id: anchor })

            await playlistRegistry.save()

            return c.json(getPlaylistData(playlist))
        } catch (err) {
            if (err instanceof UserError) return c.text(err.message, 400)
            throw err
        }
    })

    app.delete("/api/playlist/:playlist/video/:id", async c => {
        if (!isLocal(c)) return c.text("Forbidden", 403)

        try {
            const playlistId = c.req.param("playlist")
            const videoId = c.req.param("id")

            const playlistRegistry = await project.getPlaylistRegistry()
            const playlist = playlistRegistry.playlists.find(v => v.id == playlistId)

            if (playlist == null) {
                throw new UserError("Playlist with the specified ID does not exist")
            }

            const videoRegistry = await project.getVideoRegistry()
            const video = videoRegistry.videos.get(videoId)

            if (video == null) {
                throw new UserError("Video with the specified ID does not exist")
            }

            if (!playlistRegistry.removeVideoFromPlaylist(video, playlist)) {
                throw new UserError("The specified video is not in the playlist")
            }

            await playlistRegistry.save()

            return c.json(getPlaylistData(playlist))
        } catch (err) {
            if (err instanceof UserError) return c.text(err.message, 400)
            throw err
        }
    })

    function getThumbnailUrl(video: VideoInfo | null | undefined) {
        if (video?.thumbnail) {
            return `/api/thumbnail/${video.id}`
        } else {
            return `/api/thumbnail/invalid`
        }
    }

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
                    .replace(/\$\$ADMIN\$\$/, () => isLocal(c) ? "true" : "false")
                    .replace(/\$\$LIST\$\$/, () => (
                        JSON.stringify([
                            new PlaylistDisplay({
                                label: "All Videos",
                                size: videoRegistry.videos.size,
                                thumbnail: getThumbnailUrl(Optional.pcall(() => iteratorNth(videoRegistry.videos.values())).tryUnwrap()),
                            }).serialize(),
                            ...playlistRegistry.playlists.map(playlist => new PlaylistDisplay({
                                id: playlist.id, label: playlist.label, url: playlist.sourceId,
                                size: playlist.videos.length,
                                thumbnail: getThumbnailUrl(playlist.videos.at(0)),
                            }).serialize()),
                        ])
                    ))
                    .replace(/\$\$VIDEOS\$\$/, () => (
                        JSON.stringify(getPlaylistData(playlist))
                    ))
                    .replace(/\$\$VIDEO\$\$/, () => (
                        JSON.stringify({
                            ...video!.serialize(),
                            url: video!.getUrl(),
                            channelUrl: video!.getChannelUrl(),
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
