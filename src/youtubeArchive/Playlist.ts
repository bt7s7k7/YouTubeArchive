import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { printInfo } from "./print"
import { useProject } from "./state"
import { UserError } from "./UserError"
import { VideoInfo } from "./VideoInfo"

export class Playlist {
    constructor(
        public readonly url: string,
        public readonly label: string,
        public readonly videos: VideoInfo[],
    ) { }
}

export class PlaylistRegistry {
    public async save() {
        const toDelete = new Set(this.originalFiles)
        for (const playlist of this.playlists) {
            const content = [
                `url = ${playlist.url}`,
                "",
                ...playlist.videos.map(v => `${v.id} ${v.label}`),
            ]

            const configFile = join(this.path, playlist.label + ".ini")
            toDelete.delete(configFile)
            await writeFile(configFile, content.join("\n") + "\n")
        }

        for (const file of toDelete) {
            printInfo(`Deleting "${file}"...`)
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
                const videos: VideoInfo[] = []

                let i = 0
                for (let line of content.split("\n")) {
                    i++

                    line = line.trim()
                    if (line == "") continue
                    if (line.startsWith("url = ")) {
                        url = line.slice(6)
                        continue
                    }

                    let space = line.indexOf(" ")
                    if (space == -1) {
                        throw new UserError(`Syntax error at ${configFile}:${i}`)
                    }

                    const id = line.slice(0, space)
                    const video = videoRegistry.videos.get(id)
                    if (video == null) {
                        throw new UserError(`Reference to missing video "${id}" at ${configFile}:${i}`)
                    }

                    orphanVideos.delete(video)
                    videos.push(video)
                }

                if (url == null) {
                    throw new UserError(`Missing playlist url at ${configFile}`)
                }

                playlists.push(new Playlist(url, label, videos))
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
