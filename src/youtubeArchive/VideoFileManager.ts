import axios from "axios"
import { cp, mkdir, readdir, readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { unreachable } from "../comTypes/util"
import { VideoInfo } from "./VideoInfo"

const _ID_REGEXP = /\[([\w-]+)\](?:\.[a-z]+)+$/

export interface LegacyInfoFile {
    id: string
    fulltitle: string
    thumbnails: {
        "url": string,
        "height"?: number,
        "width"?: number,
        "preference": number,
        "id": string,
        "resolution"?: string
    }[]
    description: string
    channel_id: string
    channel: string
    /** This is in seconds, need to `*1000` to get milliseconds */
    timestamp: number
}

export async function indexSourceDirectory(path: string) {
    const videoFiles = new Map<string, string>()
    const infoFiles = new Map<string, string>()

    for (const dirent of await readdir(path, { recursive: true, withFileTypes: true })) {
        if (!dirent.isFile()) continue
        const id = dirent.name.match(_ID_REGEXP)?.[1]
        const fullPath = join(path, dirent.name)
        if (id == null) continue

        const isInfo = dirent.name.endsWith(".info.json")

        void (isInfo ? infoFiles : videoFiles).set(id, fullPath)
    }

    return { videoFiles, infoFiles }
}

export async function downloadThumbnail(url: string) {
    const thumbnail = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" })
    const thumbnailDataUrl = `data:image/jpeg;base64,` + Buffer.from(thumbnail.data).toString("base64")
    return thumbnailDataUrl
}

export async function parseInfoFile(path: string) {
    const content = await readFile(path, "utf-8")
    const data = JSON.parse(content) as LegacyInfoFile

    const thumbnailInfo = data.thumbnails.find(v => v.resolution == "640x480" && v.url.includes(".jpg")) ?? data.thumbnails.find(v => v.resolution == "480x360" && v.url.includes(".jpg"))
    if (thumbnailInfo == null) {
        unreachable()
    }

    const thumbnail = await downloadThumbnail(thumbnailInfo.url)

    return new VideoInfo({
        id: data.id, label: data.fulltitle, thumbnail,
        channel: data.channel, channelId: data.channel_id,
        publishedAt: new Date(data.timestamp * 1000).toISOString(),
    })
}

export function escapeFilename(name: string) {
    return name
        .replace(/:/g, "：")
        .replace(/\//g, "⧸")
        .replace(/\\/g, "⧵")
        .replace(/\|/g, "┃")
        .replace(/"/g, "“")
        .replace(/</g, "＞")
        .replace(/>/g, "＜")
        .replace(/\?/g, "？")
        .replace(/[<>:/\\|?*]/g, "_")
        .replace(/"/g, "'")
}

export class VideoFileManager {
    public readonly videos = new Map<string, string>()

    public async importVideoFile(video: VideoInfo, file: string) {
        if (this.videos.has(video.id)) unreachable()

        const resultName = escapeFilename(`${video.label} [${video.id}]${extname(file)}`)
        const fullPath = join(this.path, resultName)

        await cp(file, fullPath)

        this.videos.set(video.id, fullPath)
        video.file = resultName
    }

    public static async load(path: string) {
        await mkdir(path, { recursive: true })
        const instance = new VideoFileManager(path)

        for (const dirent of await readdir(path, { withFileTypes: true })) {
            if (!dirent.isFile()) continue
            const id = dirent.name.match(_ID_REGEXP)?.[1]
            const fullPath = join(path, dirent.name)
            if (id == null) continue
            instance.videos.set(id, fullPath)
        }

        return instance
    }

    constructor(
        public readonly path: string,
    ) { }
}
