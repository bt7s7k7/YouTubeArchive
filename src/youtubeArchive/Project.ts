import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PlaylistRegistry } from "./Playlist"
import { printInfo, printWarn } from "./print"
import { UserError } from "./UserError"
import { VideoFileManager } from "./VideoFileManager"
import { VideoRegistry } from "./VideoRegistry"

export class Project {
    protected _videoRegistry: VideoRegistry | null = null
    public async getVideoRegistry() {
        if (this._videoRegistry) return this._videoRegistry

        printInfo("Loading video registry...")

        const path = join(this.path, "videos.json")
        const videos = await VideoRegistry.load(path)

        if (videos == null) {
            printWarn("Missing video index, creating...")
            const videos = VideoRegistry.default()
            videos.path = path
            await videos.save()
            return videos
        }

        return this._videoRegistry = videos
    }

    protected _playlistRegistry: PlaylistRegistry | null = null
    public async getPlaylistRegistry() {
        if (this._playlistRegistry) return this._playlistRegistry

        printInfo("Loading playlist registry...")
        const playlists = await PlaylistRegistry.load(this.path)

        return this._playlistRegistry = playlists
    }

    protected _videoFileManager: VideoFileManager | null = null
    public async getVideoFileManager() {
        if (this._videoFileManager) return this._videoFileManager

        printInfo("Loading video files...")
        const manager = await VideoFileManager.load(join(this.path, "videos"))

        return this._videoFileManager = manager
    }

    protected _token: string | null = null
    public getToken() {
        if (this._token != null) return this._token
        try {
            return this._token = readFileSync(join(this.path, "token.txt"), "utf-8").trim()
        } catch (err: any) {
            if (err.code == "ENOENT") {
                throw new UserError("Missing YouTube token (token.txt)")
            }

            throw err
        }
    }

    constructor(
        public path: string,
    ) { }
}
