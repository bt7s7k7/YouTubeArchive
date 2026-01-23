import axios, { AxiosError } from "axios"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { ensureKey } from "../comTypes/util"
import { UserError } from "./UserError"
import { VideoInfo } from "./VideoInfo"
import { printError } from "./print"
import { VideoData } from "./youtubeApi"

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
        const fullPath = join(dirent.path ?? dirent.parentPath, dirent.name)
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
    try {
        const thumbnail = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer" })
        const thumbnailDataUrl = `data:image/jpeg;base64,` + Buffer.from(thumbnail.data).toString("base64")
        return thumbnailDataUrl
    } catch (err) {
        if (err instanceof AxiosError) {
            return null
        } else {
            throw err
        }
    }
}

export async function parseInfoFile(path: string) {
    const content = await readFile(path, "utf-8")
    const data = JSON.parse(content) as LegacyInfoFile

    let thumbnail: string | null = null
    for (const resolution of ["640x480", "480x360"]) {
        let thumbnailUrl = data.thumbnails.find(v => v.resolution == resolution && v.url.includes(".jpg"))?.url
        if (thumbnailUrl == null) continue
        thumbnail = await downloadThumbnail(thumbnailUrl)
        if (thumbnail != null) break
    }

    if (thumbnail == null) {
        printError(`Failed to download thumbnail for "${data.fulltitle}" (${data.id})`)
    }

    return new VideoInfo({
        id: data.id, label: data.fulltitle, thumbnail,
        channel: data.channel, channelId: data.channel_id,
        publishedAt: new Date(data.timestamp * 1000).toISOString(),
        description: data.description,
    })
}

export function parseYoutubeVideo(videoData: VideoData) {
    return new VideoInfo({
        id: videoData.id ?? videoData.snippet.resourceId.videoId,
        thumbnail: null,
        label: videoData.snippet.title,
        description: videoData.snippet.description,

        // The following properties are in different places based on if the video data object is from the playlist or video API request (the first alternative is playlist API)
        publishedAt: videoData.contentDetails?.videoPublishedAt ?? videoData.snippet.publishedAt,
        channel: videoData.snippet.videoOwnerChannelTitle ?? videoData.snippet.channelTitle,
        channelId: videoData.snippet.videoOwnerChannelId ?? videoData.snippet.channelId,
    })
}

export async function downloadThumbnailBasedOnYoutubeVideo(video: VideoInfo, videoData: VideoData) {
    if (videoData.snippet.thumbnails.high == null) {
        // eslint-disable-next-line no-console
        console.log(videoData)
        throw new UserError(`Invalid data for video "${video.label}" (${video.id})`)
    }

    video.thumbnail = await downloadThumbnail(videoData.snippet.thumbnails.standard?.url ?? videoData.snippet.thumbnails.high.url)
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

export function getCaptionsExt(captionsFile: string) {
    const ext = captionsFile.match(/((?:\.[a-z0-9]+)+)$/)?.[1]

    if (ext == null) {
        throw new UserError(`Failed to parse extension from captions file "${captionsFile}"`)
    }

    return ext
}

export class VideoFileManager {
    public async importVideoFile(video: VideoInfo, file: string) {
        const resultName = _getFilenameForVideo(video, extname(file))
        const fullPath = join(this.path, resultName)

        await cp(file, fullPath)

        video.file = relative(this.path, fullPath)
    }

    public async importCaptionsFile(video: VideoInfo, captionsFile: string) {
        const ext = getCaptionsExt(captionsFile)

        const fullPath = join(this.path, _getFilenameForVideo(video, ext))
        await cp(captionsFile, fullPath)
        void (video.captions ??= []).push(relative(this.path, fullPath))
    }

    public async importCaptionsRaw(video: VideoInfo, language: string, captionsFileContent: string) {
        const fullPath = join(this.path, _getFilenameForVideo(video, `.${language}.vtt`))
        await writeFile(fullPath, captionsFileContent)
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

    public async deleteFile(name: string) {
        await rm(join(this.path, name))
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
