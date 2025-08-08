import axios from "axios"
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { ensureKey, unreachable } from "../comTypes/util"
import { UserError } from "./UserError"
import { VideoInfo } from "./VideoInfo"

const _ID_REGEXP = /\[([\w-]+)\](?:\.[a-z0-9]+)+$/

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

export interface SourceFiles {
    videoFile: string | null
    infoFile: string | null
    captionFiles: string[] | null
}

export async function indexSourceDirectory(path: string) {
    const files = new Map<string, SourceFiles>()

    for (const dirent of await readdir(path, { recursive: true, withFileTypes: true })) {
        if (!dirent.isFile()) continue
        const id = dirent.name.match(_ID_REGEXP)?.[1]
        const fullPath = join(dirent.path ?? "", dirent.name)
        if (id == null) continue

        const file = ensureKey(files, id, () => ({ videoFile: null, infoFile: null, captionFiles: null }))

        const isInfo = dirent.name.endsWith(".info.json")
        const isCaptions = dirent.name.endsWith(".vtt")
        if (isInfo) {
            file.infoFile = fullPath
        } else if (isCaptions) {
            (file.captionFiles ??= []).push(fullPath)
        } else {
            file.videoFile = fullPath
        }
    }

    return files
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

function _getFilenameForVideo(video: VideoInfo, ext: string) {
    return escapeFilename(`${video.label} [${video.id}]${ext}`)
}

export class VideoFileManager {
    public async importVideoFile(video: VideoInfo, file: string) {
        const resultName = _getFilenameForVideo(video, extname(file))
        const fullPath = join(this.path, resultName)

        await cp(file, fullPath)

        video.file = relative(this.path, fullPath)
    }

    public async importCaptionsFile(video: VideoInfo, captionsFile: string) {
        const ext = captionsFile.match(/((?:\.[a-z0-9]+)+)$/)?.[1]
        if (ext == null) {
            throw new UserError(`Failed to parse extension from captions file "${captionsFile}"`)
        }

        const fullPath = join(this.path, _getFilenameForVideo(video, ext))
        await cp(captionsFile, fullPath)
        void (video.captions ??= []).push(relative(this.path, fullPath))
    }

    public async wipeVideoFiles(video: VideoInfo) {
        if (video.file) {
            await rm(join(this.path, video.file))
        }

        if (video.captions) {
            for (const captionFile of video.captions) {
                await rm(join(this.path, captionFile))
            }
        }
    }

    public static async load(path: string) {
        await mkdir(path, { recursive: true })
        const instance = new VideoFileManager(path)

        return instance
    }

    constructor(
        public readonly path: string,
    ) { }
}
