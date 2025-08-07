import { readFile, writeFile } from "node:fs/promises"
import { modify, unreachable } from "../comTypes/util"
import { Struct } from "../struct/Struct"
import { Type } from "../struct/Type"
import { VideoInfo } from "./VideoInfo"

export class VideoRegistry extends Struct.define("VideoRegistry", {
    videos: VideoInfo.ref().as(Type.keyIndexedArray, "id" as const),
}) {
    public path: string = null!

    public async save() {
        await writeFile(this.path, JSON.stringify(this.serialize(), null, 4))
    }

    public addVideo(video: VideoInfo) {
        if (this.videos.get(video.id)) unreachable()
        this.videos.set(video.id, video)
    }

    public static async load(path: string) {
        try {
            return modify(VideoRegistry.ref().deserialize(JSON.parse(await readFile(path, "utf-8"))), { path })
        } catch (err: any) {
            if (err.code == "ENOENT") {
                return null
            }
            throw err
        }
    }
}
