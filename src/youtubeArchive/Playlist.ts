import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readwrite } from "../comTypes/types"
import { autoFilter, ensureKey, makeRandomID, unreachable } from "../comTypes/util"
import { printInfo } from "./print"
import { useProject } from "./state"
import { UserError } from "./UserError"
import { VideoInfo } from "./VideoInfo"

export class Playlist {
    constructor(
        public readonly id: string,
        public sourceId: string | null,
        public label: string,
        public readonly videos: readonly VideoInfo[],
        public readonly labels: Map<number, string>,
    ) { }

    public getUrl() {
        if (this.sourceId != null) {
            return `https://youtube.com/playlist?list=${this.sourceId}`
        } else {
            return null
        }
    }
}

export class PlaylistRegistry {
    protected _videoCache: Map<string, Set<string>> | null = null
    protected _getVideoCache() {
        if (this._videoCache == null) {
            this._videoCache = new Map()

            for (const playlist of this.playlists) {
                for (const video of playlist.videos) {
                    ensureKey(this._videoCache, video.id, () => new Set()).add(playlist.id)
                }
            }
        }
        return this._videoCache
    }

    public getPlaylistsContainingVideo(video: VideoInfo) {
        const playlistIds = this._getVideoCache().get(video.id)
        if (playlistIds == null) return []

        return autoFilter([...playlistIds].map(v => this.playlists.find(w => w.id == v)))
    }

    public isVideoOrphan(video: VideoInfo) {
        const playlistIds = this._getVideoCache().get(video.id)
        if (playlistIds == null) return true
        return playlistIds.size == 0
    }

    public addVideoToPlaylist(video: VideoInfo, playlist: Playlist) {
        this.insertVideoToPlaylist(video, playlist, playlist.videos.length)
    }

    public insertVideoToPlaylist(video: VideoInfo, playlist: Playlist, index: number) {
        (playlist.videos as Readwrite<typeof playlist.videos>).splice(index, 0, video)
        const labels = [...playlist.labels.entries()]
        labels.reverse()

        for (const [labelIndex, label] of labels) {
            if (labelIndex >= index) {
                playlist.labels.delete(labelIndex)
                const existing = playlist.labels.get(labelIndex + 1)
                if (existing != null) {
                    playlist.labels.set(labelIndex + 1, label + "\n" + existing)
                } else {
                    playlist.labels.set(labelIndex + 1, label)
                }
            }
        }

        ensureKey(this._getVideoCache(), video.id, () => new Set()).add(playlist.id)
    }

    public removeVideoFromPlaylist(video: VideoInfo, playlist: Playlist) {
        const index = playlist.videos.indexOf(video)
        if (index == -1) return false

        void (playlist.videos as Readwrite<typeof playlist.videos>).splice(index, 1)

        const labels = [...playlist.labels.entries()]

        for (const [labelIndex, label] of labels) {
            if (labelIndex > index) {
                playlist.labels.delete(labelIndex)
                const existing = playlist.labels.get(labelIndex - 1)
                if (existing != null) {
                    playlist.labels.set(labelIndex - 1, existing + "\n" + label)
                } else {
                    playlist.labels.set(labelIndex - 1, label)
                }
            }
        }

        this._getVideoCache().get(video.id)?.delete(playlist.id)
        return true
    }

    public deletePlaylist(playlist: Playlist) {
        const index = this.playlists.indexOf(playlist)
        if (index == -1) unreachable()
        for (const video of playlist.videos) {
            this.removeVideoFromPlaylist(video, playlist)
        }
        this.playlists.splice(index, 1)
    }

    public async save() {
        const toDelete = new Set(this.originalFiles)
        this.originalFiles.length = 0

        for (const playlist of this.playlists) {
            const content = [
                `id = ${playlist.id}`,
                playlist.sourceId != null ? `url = ${playlist.sourceId}\n` : "",
                ...playlist.videos.flatMap((v, i) => {
                    const video = `${v.id} ${v.label}`

                    const label = playlist.labels.get(i)
                    if (label != null) {
                        return [
                            "",
                            ...label.split("\n").map(v => ">>> " + v),
                            video,
                        ]
                    }

                    return [video]
                }),
            ]

            const configFile = join(this.path, playlist.label + ".ini")
            toDelete.delete(configFile)
            this.originalFiles.push(configFile)
            await writeFile(configFile, content.join("\n") + "\n")
        }

        for (const file of toDelete) {
            printInfo(`Deleting "${file}"...`)
            await rm(file)
        }
    }

    public static async load(path: string) {
        const videoRegistry = await useProject().getVideoRegistry()
        const orphanVideos = new Set(videoRegistry.videos.values())
        const playlists: Playlist[] = []
        const originalFiles: string[] = []

        for (const dirent of await readdir(path, { withFileTypes: true })) {
            if (dirent.isFile() && dirent.name.endsWith(".ini")) {
                const configFile = join(path, dirent.name)
                originalFiles.push(configFile)
                const label = dirent.name.slice(0, -4)
                const content = await readFile(configFile, "utf-8")

                let url: string | null = null
                let id = makeRandomID()
                const videos: VideoInfo[] = []
                const labels = new Map<number, string>()

                let i = 0
                for (let line of content.split("\n")) {
                    i++

                    line = line.trim()
                    if (line == "") continue

                    if (line.startsWith("url = ")) {
                        url = line.slice(6)
                        continue
                    }

                    if (line.startsWith("id = ")) {
                        id = line.slice(5)
                        continue
                    }

                    if (line.startsWith(">")) {
                        const start = line.match(/[^>]/)
                        if (!start) continue
                        const startIndex = start.index
                        const label = line.slice(startIndex).trim()

                        if (labels.has(videos.length)) {
                            labels.set(videos.length, labels.get(videos.length) + "\n" + label)
                        } else {
                            labels.set(videos.length, label)
                        }

                        continue
                    }

                    let space = line.indexOf(" ")
                    if (space == -1) {
                        space = line.length
                    }

                    const videoId = line.slice(0, space)
                    const video = videoRegistry.videos.get(videoId)
                    if (video == null) {
                        throw new UserError(`Reference to missing video "${videoId}" at ${configFile}:${i}`)
                    }

                    orphanVideos.delete(video)
                    videos.push(video)
                }

                playlists.push(new Playlist(id, url, label, videos, labels))
            }
        }

        return new PlaylistRegistry(path, originalFiles, playlists, orphanVideos)
    }

    constructor(
        public readonly path: string,
        public readonly originalFiles: string[],
        public readonly playlists: Playlist[],
        public readonly orphanVideos: Set<VideoInfo>,
    ) { }
}
