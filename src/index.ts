import { AxiosError } from "axios"
import { exec } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { inspect } from "node:util"
import { Cli } from "./cli/Cli"
import { GenericParser } from "./comTypes/GenericParser"
import { arrayRemove, asyncConcurrency, makeRandomID, unreachable } from "./comTypes/util"
import { startServer } from "./startServer"
import { Type } from "./struct/Type"
import { convertSrtToVtt } from "./youtubeArchive/convertSrtToVtt"
import { Playlist } from "./youtubeArchive/Playlist"
import { print, printError, printInfo, printWarn } from "./youtubeArchive/print"
import { Project } from "./youtubeArchive/Project"
import { setActiveProject, useProject } from "./youtubeArchive/state"
import { UserError } from "./youtubeArchive/UserError"
import { downloadThumbnailBasedOnYoutubeVideo, getCaptionsExt, indexSourceDirectory, parseInfoFile, parseYoutubeVideo } from "./youtubeArchive/VideoFileManager"
import { VideoInfo } from "./youtubeArchive/VideoInfo"
import { getPlaylistVideos, getVideoMetadata } from "./youtubeArchive/youtubeApi"

void (async () => {
    let rootPath = process.cwd()
    let shouldExit = true

    const cli = new Cli("index.mjs")
        .addOption({
            name: "", desc: "Start the interactive user interface",
            params: [
                ["path", Type.string.as(Type.nullable)],
            ],
            async callback(path) {
                if (path != null) rootPath = resolve(path)
                shouldExit = false
            },
        })
        .addOption({
            name: "help", desc: "Prints the help message",
            async callback() {
                cli.printHelp()
            },
        })
        .addOption({
            name: "srt2vtt", desc: "Invoke the SRT to VTT format convertor",
            params: [
                ["source", Type.string],
                ["destination", Type.string.as(Type.nullable)],
            ],
            async callback(source, destination) {
                destination ??= join(dirname(source), basename(source, extname(source)) + ".vtt")

                await writeFile(destination, convertSrtToVtt(await readFile(source, "utf-8")))
            },
        })

    await cli.execute(process.argv.slice(2))
    if (shouldExit) return

    if (rootPath != process.cwd()) {
        printWarn(`Opening archive project at "${rootPath}"`)
    }

    let closed = false
    let _tmp: string | null = null
    function getTempFolder() {
        return _tmp ??= mkdtempSync(join(tmpdir(), "archive.downloads."))
    }

    const VIDEO_PROPERTIES = {
        label: Type.string.as(Type.nullable),
        description: Type.string.as(Type.nullable),
        publishedAt: Type.string.as(Type.nullable),
        channel: Type.string.as(Type.nullable),
        channelId: Type.string.as(Type.nullable),
    }

    type VideoProperties = Type.Extract<Type.TypedObjectType<typeof VIDEO_PROPERTIES>>

    function validateVideoProperties(properties: VideoProperties) {
        if (properties.publishedAt != null) {
            const date = new Date(properties.publishedAt)
            if (date.toString() == "Invalid Date") {
                throw new UserError(`Invalid date "${properties.publishedAt}"`)
            }
            properties.publishedAt = date.toISOString()
        }
    }

    async function deleteVideo(video: VideoInfo) {
        const project = useProject()
        const videoRegistry = await project.getVideoRegistry()
        const videoFileManager = await project.getVideoFileManager()
        const playlistRegistry = await project.getPlaylistRegistry()

        await videoFileManager.wipeVideoFiles(video)
        for (const playlist of playlistRegistry.getPlaylistsContainingVideo(video)) {
            playlistRegistry.removeVideoFromPlaylist(video, playlist)
        }
        videoRegistry.videos.delete(video.id)
    }

    async function getPlaylistByIndex(index: number) {
        const project = useProject()
        const playlistRegistry = await project.getPlaylistRegistry()

        const playlist = playlistRegistry.playlists.at(index - 1)
        if (playlist == null) {
            throw new UserError("Index outside range")
        }

        return playlist
    }

    async function getOrphanVideos() {
        const project = useProject()
        const videoRegistry = await project.getVideoRegistry()
        const playlistRegistry = await project.getPlaylistRegistry()

        return [...videoRegistry.videos.values()].filter(v => playlistRegistry.isVideoOrphan(v))
    }

    async function areYouSure() {
        if ((await rl.question("Are you sure? [y/n]")) != "y\x1b[0m") {
            printWarn("Operation aborted")
            return false
        }

        return true
    }

    function downloadVideo(video: VideoInfo, path: string, { useCookies = false, subsOnly = false } = {}) {
        if (useCookies && subsOnly) unreachable()

        const command = useCookies ? (
            `yt-dlp --cookies-from-browser chrome "https://www.youtube.com/watch?v=${video.id}"`
        ) : (
            subsOnly ? (
                `yt-dlp --write-subs --sub-langs ".*" --skip-download "https://www.youtube.com/watch?v=${video.id}"`
            ) : (
                `yt-dlp --write-subs --sub-langs ".*" "https://www.youtube.com/watch?v=${video.id}"`
            )
        )

        return new Promise<boolean>((resolve) => exec(command, { cwd: path }, (error, stdout, stderr) => {
            if (error) {
                printError(`Failed to download "${video.label}", ${stderr}`)
                resolve(false)
            }
            resolve(true)
        }))
    }

    const repl = new Cli("")
        .addOption({
            name: "quit", desc: "Stops the application",
            async callback() {
                rl.close()
                closed = true
            },
        })
        .addOption({
            name: "help", desc: "Prints help text",
            async callback() {
                repl.printHelp()
            },
        })
        .addOption({
            name: "reload", desc: "Clears cache to reload config files",
            options: {
                path: Type.string.as(Type.nullable),
            },
            async callback({ path }) {
                path ??= rootPath
                const project = new Project(path)
                setActiveProject(project)
                await project.getVideoRegistry()
                await project.getPlaylistRegistry()
            },
        })
        .addOption({
            name: "status", desc: "Prints the status of the current project",
            async callback() {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const videoRegistry = await project.getVideoRegistry()

                if (playlistRegistry.playlists.length == 0) {
                    printWarn("No archived playlists")
                } else {
                    print("Playlists:")
                    let i = 0
                    for (const playlist of playlistRegistry.playlists) {
                        print(`  ${(i + 1).toString().padStart(2, " ")}. \x1b[92m${playlist.label}\x1b[0m \x1b[2m${playlist.videos.length} videos (https://youtube.com/playlist?list=${playlist.url})\x1b[0m`)
                        i++
                    }
                }

                const orphans = await getOrphanVideos()
                if (orphans.length > 0) {
                    printWarn(`\nDetected ${orphans.length} orphan videos`)
                }

                let missing = 0
                for (const video of videoRegistry.videos.values()) {
                    if (video.file == null) missing++
                }

                if (missing > 0) {
                    printError(`\nMissing ${missing} video files`)
                }
            },
        })
        .addOption({
            name: "playlist add", desc: "Adds a playlist to be archived",
            params: [
                ["url", Type.string],
            ],
            options: {
                label: Type.string.as(Type.nullable),
            },
            async callback(url, { label }) {
                if (url.includes("list=")) {
                    url = url.match(/list=([\w-]+)/)![1]
                }

                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()

                label ??= "Playlist " + (playlistRegistry.playlists.length + 1)
                if (playlistRegistry.playlists.find(v => v.label == label)) {
                    printError("Duplicate playlist name")
                    return
                }

                playlistRegistry.playlists.push(new Playlist(makeRandomID(), url, label, []))
                await playlistRegistry.save()

                printInfo(`Added playlist "${label}"`)
            },
        })
        .addOption({
            name: "playlist set url", desc: "Changes the url of the selected playlist",
            params: [
                ["index", Type.number],
                ["url", Type.string],
            ],
            async callback(index, url) {
                if (url.includes("list=")) {
                    url = url.match(/list=([\w-]+)/)![1]
                }

                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = await getPlaylistByIndex(index)

                playlist.url = url
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "playlist delete", desc: "Deletes a playlist",
            params: [
                ["index", Type.number],
            ],
            async callback(index, url) {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = await getPlaylistByIndex(index)

                printWarn(`You are about to delete playlist: "${playlist.label}"`)
                if (!await areYouSure()) return

                playlistRegistry.deletePlaylist(playlist)
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "view", desc: "View videos in a playlist",
            params: [
                ["index", Type.number],
            ],
            async callback(index) {
                const playlist = await getPlaylistByIndex(index)

                let i = 0
                for (const video of playlist.videos) {
                    i++
                    const msg = `${i.toString().padStart(3, " ")}. ${video.label}`
                    print(`${`${i.toString().padStart(3, " ")}. ${video.label}` + (video.file == null ? "\x1b[91m (Missing)\x1b[0m" : "")} \x1b[2mhttps://youtu.be/${video.id}\x1b[0m`)
                }

            },
        })
        .addOption({
            name: "orphans", desc: "List orphaned videos",
            async callback() {
                let i = 0
                for (const video of await getOrphanVideos()) {
                    i++
                    print(`${`${i.toString().padStart(3, " ")}. ${video.label}` + (video.file == null ? "\x1b[91m (Missing)\x1b[0m" : "")} \x1b[2mhttps://youtu.be/${video.id}\x1b[0m`)
                }
            },
        })
        .addOption({
            name: "missing", desc: "List videos without video files",
            async callback() {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                let i = 0
                for (const video of videoRegistry.videos.values()) {
                    if (video.file != null) continue
                    i++
                    print(`${`${i.toString().padStart(3, " ")}. ${video.label}` + (video.file == null ? "\x1b[91m (Missing)\x1b[0m" : "")} \x1b[2mhttps://youtu.be/${video.id}\x1b[0m`)
                }
            },
        })
        .addOption({
            name: "fetch", desc: "Fetches the list of videos in each playlist",
            async callback() {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlists = playlistRegistry.playlists
                const videoRegistry = await project.getVideoRegistry()
                const videos = videoRegistry.videos

                const playlistConcurrency = asyncConcurrency(4)
                const videoConcurrency = asyncConcurrency(10)

                for (const playlist of playlists) {
                    playlistConcurrency.push(async () => {
                        const videoSnippets = await getPlaylistVideos(playlist.label, playlist.url, project.getToken())
                        const ids: string[] = []
                        for (const videoData of videoSnippets) {
                            if (videoData.contentDetails.videoPublishedAt == null) {
                                printError(`Skipping private video "${videoData.contentDetails.videoId}"`)
                                continue
                            }

                            const id = videoData.snippet.resourceId.videoId
                            ids.push(id)
                            let video = videos.get(id)

                            if (video == null) {
                                video = new VideoInfo({
                                    id,
                                    thumbnail: null,
                                    label: videoData.snippet.title,
                                    publishedAt: videoData.contentDetails.videoPublishedAt,
                                    channel: videoData.snippet.videoOwnerChannelTitle,
                                    channelId: videoData.snippet.videoOwnerChannelId,
                                    description: videoData.snippet.description,
                                })

                                videoRegistry.addVideo(video)
                                videoConcurrency.push(async () => {
                                    await downloadThumbnailBasedOnYoutubeVideo(video!, videoData)
                                })
                            }

                            if (playlist.videos.includes(video)) continue

                            print(`[${playlist.label}] New video: ${video.label}`)

                            let index = -1
                            for (let i = ids.length - 1; i >= 0; i--) {
                                const prevId = ids[i]
                                const video = videos.get(prevId) ?? unreachable()
                                index = playlist.videos.indexOf(video)
                                if (index != -1) break
                            }

                            if (index == -1) {
                                playlistRegistry.addVideoToPlaylist(video, playlist)
                            } else {
                                playlistRegistry.insertVideoToPlaylist(video, playlist, index + 1)
                            }
                        }
                    })
                }

                await playlistConcurrency.join()
                await videoConcurrency.join()

                await videoRegistry.save()
                await playlistRegistry.save()

                await executeCommand("status")
            },
        })
        .addOption({
            name: "pull", desc: "Downloads missing video files",
            async callback() {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                let path: string | null = null
                const concurrency = asyncConcurrency(10)

                for (const video of videoRegistry.videos.values()) {
                    if (video.file != null) continue

                    concurrency.push(async () => {
                        path ??= getTempFolder()
                        print(`Downloading "${video.label}"`)
                        let success = await downloadVideo(video, path!)
                        if (!success) {
                            success = await downloadVideo(video, path!, { useCookies: true })
                        }

                        if (!success) return

                        const files = (await indexSourceDirectory(path)).get(video.id)
                        const videoFile = files?.videoFile
                        if (videoFile == null) {
                            printError(`Cannot find video file for "${video.id}"`)
                            return
                        }

                        print(`Finished "${video.label}"`)
                        await videoFileManager.importVideoFile(video, videoFile)

                        if (files!.captionFiles != null) {
                            for (const captionFile of files!.captionFiles) {
                                await videoFileManager.importCaptionsFile(video, captionFile)
                            }
                        }
                    })
                }

                await concurrency.join()

                await videoRegistry.save()
                if (path != null) {
                    await rm(path, { force: true, recursive: true })
                    _tmp = null
                }
            },
        })
        .addOption({
            name: "pull captions", desc: "Downloads missing video captions",
            async callback() {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                let path: string | null = null
                const concurrency = asyncConcurrency(10)

                for (const video of videoRegistry.videos.values()) {
                    if (video.captions != null) continue

                    concurrency.push(async () => {
                        path ??= getTempFolder()
                        print(`Downloading "${video.label}"`)
                        let success = await downloadVideo(video, path!, { subsOnly: true })

                        if (!success) return

                        const files = (await indexSourceDirectory(path)).get(video.id)
                        const captionFiles = files?.captionFiles
                        if (captionFiles == null) {
                            printError(`Cannot find caption files for "${video.label}"`)
                            return
                        } else {
                            printInfo(`Found caption files for "${video.label}"`)
                        }

                        for (const captionsFile of captionFiles) {
                            await videoFileManager.importCaptionsFile(video, captionsFile)
                        }
                    })
                }

                await concurrency.join()
                await videoRegistry.save()
                if (path != null) {
                    await rm(path, { force: true, recursive: true })
                    _tmp = null
                }
            },
        })
        .addOption({
            name: "legacy pull", desc: "Pulls video files from a legacy archive",
            params: [
                ["path", Type.string],
            ],
            async callback(path) {
                const files = await indexSourceDirectory(path)
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const concurrency = asyncConcurrency(10)

                for (const video of videoRegistry.videos.values()) {
                    if (video.file == null) {
                        const videoFile = files.get(video.id)?.videoFile
                        if (videoFile != null) {
                            concurrency.push(async () => {
                                print(`Importing video "${video.label}"`)
                                await videoFileManager.importVideoFile(video, videoFile)
                            })
                        } else {
                            printError(`Cannot find video "${video.label}"`)
                        }
                    }

                    if (video.captions == null) {
                        const captionFiles = files.get(video.id)?.captionFiles
                        if (captionFiles != null) {
                            concurrency.push(async () => {
                                print(`Importing captions "${video.label}"`)
                                for (const captionFile of captionFiles) {
                                    await videoFileManager.importCaptionsFile(video, captionFile)
                                }
                            })
                        }
                    }
                }

                await concurrency.join()
                await videoRegistry.save()
            },
        })
        .addOption({
            name: "legacy fetch", desc: "Imports videos from a legacy archive into a playlist",
            params: [
                ["index", Type.number],
                ["path", Type.string],
            ],
            async callback(index, path) {
                const files = await indexSourceDirectory(path)
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = playlistRegistry.playlists.at(index - 1)
                if (playlist == null) {
                    throw new UserError("Index outside range")
                }

                const concurrency = asyncConcurrency(4)
                const ids: string[] = []

                for (const [id, { videoFile, captionFiles, infoFile }] of files) {
                    ids.push(id)
                    concurrency.push(async () => {
                        let video = videoRegistry.videos.get(id)
                        if (video == null) {
                            if (infoFile == null) {
                                printError(`Skipped importing "${infoFile}" because it has no info file`)
                                return
                            }

                            if (videoFile == null) {
                                printError(`Skipped importing "${videoFile}" because it has no video file`)
                                return
                            }

                            print(`Importing video "${videoFile}"`)
                            video = await parseInfoFile(infoFile)
                            await videoFileManager.importVideoFile(video, videoFile)
                            videoRegistry.addVideo(video)
                        }

                        if (video.captions == null && captionFiles != null) {
                            for (const captionFile of captionFiles) {
                                await videoFileManager.importCaptionsFile(video, captionFile)
                            }
                        }


                    })
                }

                await concurrency.join()

                for (const id of ids) {
                    const video = videoRegistry.videos.get(id)
                    if (video == null) {
                        continue
                    }
                    if (!playlist.videos.includes(video)) {
                        playlistRegistry.addVideoToPlaylist(video, playlist)
                    }
                }

                await videoRegistry.save()
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "wipe videos", desc: "Deletes all video files",
            async callback() {
                if (!await areYouSure()) return

                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                await rm(videoFileManager.path, { recursive: true, force: true })
                for (const video of videoRegistry.videos.values()) {
                    video.file = null
                    video.captions = null
                }

                await videoRegistry.save()
            },
        })
        .addOption({
            name: "video delete", desc: "Deletes a video",
            params: [
                ["id", Type.string],
            ],
            async callback(id) {
                if (!await areYouSure()) return

                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const playlistRegistry = await project.getPlaylistRegistry()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Cannot find selected video")
                }

                await deleteVideo(video)

                await videoRegistry.save()
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "video add", desc: "Adds a new video",
            params: [
                ["id", Type.string],
            ],
            options: VIDEO_PROPERTIES,
            async callback(id, properties) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                if (videoRegistry.videos.has(id)) {
                    throw new UserError("Video with the specified ID already exists")
                }

                validateVideoProperties(properties)
                const video = new VideoInfo({
                    id,
                    label: id,
                    description: "",
                    publishedAt: new Date().toISOString(),
                })

                for (const [key, value] of Object.entries(properties)) {
                    if (value != null) {
                        (video as any)[key] = value
                    }
                }

                videoRegistry.addVideo(video)
                await videoRegistry.save()
            },
        })
        .addOption({
            name: "video update", desc: "Allows you to update video metadata",
            params: [
                ["id", Type.string],
            ],
            options: VIDEO_PROPERTIES,
            async callback(id, properties) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                validateVideoProperties(properties)

                for (const [key, value] of Object.entries(properties)) {
                    if (value != null) {
                        (video as any)[key] = value
                    }
                }

                await videoRegistry.save()
            },
        })
        .addOption({
            name: "video", desc: "Displays video metadata",
            params: [
                ["id", Type.string],
            ],
            async callback(id) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                const { label, description, ...other } = video
                    ;
                (other as any).thumbnail = other.thumbnail != null ? { [inspect.custom]() { return "\x1b[93myes\x1b[0m" } } : { [inspect.custom]() { return "\x1b[93mno\x1b[0m" } }

                print(
                    `\x1b[96mLabel:\x1b[0m ${label}\n` +
                    `\x1b[96mDescription:\x1b[0m\n\x1b[2m${description}\x1b[0m\n` +
                    `\x1b[96mMetadata:\x1b[0m ${inspect(other, undefined, undefined, true)}\n`,
                )
            },
        })
        .addOption({
            name: "video fetch", desc: "Fetches metadata for a video",
            params: [
                ["id", Type.string],
            ],
            async callback(id) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                const videoData = await getVideoMetadata(video.id, project.getToken())
                const fetchedVideo = parseYoutubeVideo(videoData)

                for (const key of Object.keys(VIDEO_PROPERTIES)) {
                    // @ts-ignore
                    video[key] = fetchedVideo[key]
                }

                await downloadThumbnailBasedOnYoutubeVideo(video, videoData)

                await videoRegistry.save()
            },
        })
        .addOption({
            name: "video captions import", desc: "Imports captions from a VTT or SRT file.",
            params: [
                ["id", Type.string],
                ["file", Type.string],
            ],
            options: {
                language: Type.string.as(Type.nullable),
            },
            async callback(id, file, { language }) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                let fileData
                try {
                    fileData = await readFile(file, "utf-8")
                } catch (err: any) {
                    throw new UserError("Failed to read file: " + err.message)
                }

                if (language == null) {
                    const ext = getCaptionsExt(file)
                    const languageCode = basename(ext, extname(ext))
                    if (languageCode == ext || !languageCode) {
                        throw new UserError("Failed to parse language code from file extension, please specify the language")
                    }
                    language = languageCode.slice(1)
                }

                const extension = extname(file)
                if (extension == ".srt") {
                    const captions = convertSrtToVtt(fileData)
                    await videoFileManager.importCaptionsRaw(video, language, captions)
                } else if (extension == ".vtt") {
                    await videoFileManager.importCaptionsFile(video, file)
                } else {
                    throw new UserError("Only SRT or VTT files are supported")
                }

                print("Video captions:")
                for (const captionFile of video.captions!) {
                    print("  " + captionFile)
                }

                await videoRegistry.save()
            },
        })
        .addOption({
            name: "video captions delete", desc: "Deletes captions from a video.",
            params: [
                ["id", Type.string],
                ["type", Type.string],
            ],
            async callback(id, type) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                if (video.captions == null) {
                    throw new UserError("Selected video does not have captions")
                }

                const toDelete = video.captions.filter(v => v.endsWith(type))
                if (toDelete.length == 0) {
                    throw new UserError("The provided pattern does not match any captions")
                }

                print("The following files will be deleted:")
                for (const file of toDelete) {
                    print("  " + file)
                }

                if (!await areYouSure()) return

                for (const file of toDelete) {
                    arrayRemove(video.captions, file)
                    await videoFileManager.deleteFile(file)
                }

                if (video.captions.length == 0) video.captions = null

                await videoRegistry.save()
            },
        })
        .addOption({
            name: "orphans delete", desc: "Deletes all orphan videos",
            async callback() {
                printWarn("You are about to delete:")
                await executeCommand("orphans")

                if (!await areYouSure()) return

                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const playlistRegistry = await project.getPlaylistRegistry()

                for (const orphan of await getOrphanVideos()) {
                    print(`Deleting "${orphan.label}"`)
                    await deleteVideo(orphan)
                }

                await videoRegistry.save()
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "flush", desc: "Rewrite all data files to a normalized form",
            async callback() {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const playlistRegistry = await project.getPlaylistRegistry()

                await videoRegistry.save()
                await playlistRegistry.save()
            },
        })


    function parseArgs(input: string) {
        const args: string[] = []
        let arg = ""
        const parser = new GenericParser(input)
        while (!parser.isDone()) {
            arg += parser.readUntil((v, i) => v[i] == "\"" || v[i] == "'" || v[i] == " ")
            if (parser.isDone()) break

            if (parser.consume(" ")) {
                if (arg.length > 0) args.push(arg)
                arg = ""
                continue
            }

            if (parser.consume("\"")) {
                arg += parser.readUntil("\"")
                parser.index++
                continue
            }

            if (parser.consume("'")) {
                arg += parser.readUntil("'")
                parser.index++
                continue
            }
        }

        if (arg.length > 0) args.push(arg)
        return args
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[33m>\x1b[96m ",
        async completer(line) {
            const result = repl.autocomplete(line)

            const args = parseArgs(line)
            const match = repl.findCommand(args)
            if (match && match[1].fullName.startsWith("video")) {
                const idMatch = line.match(new RegExp(`^${match[1].fullName} ([\\w-]+)$`))
                if (idMatch) {
                    const idStart = idMatch[1]
                    const videoRegistry = await useProject().getVideoRegistry()
                    const videos = [...videoRegistry.videos.keys()].filter(v => v.startsWith(idStart))
                    result.push(...videos.map(v => `${match[1].fullName} ${v}`))
                }
            }

            return [result, line]
        },
    })

    async function executeCommand(input: string) {
        if (input.trim() == "") return
        const args = parseArgs(input)

        try {
            await repl.execute(args)
        } catch (err) {
            if (err instanceof UserError) {
                printError(err.message)
            } else if (err instanceof AxiosError) {
                printError(err.message + " at " + err.request.host + err.request.path)
            } else {
                throw err
            }
        }
    }

    await executeCommand("reload")
    const server = startServer()

    rl.resume()
    rl.prompt()
    for await (let input of rl) {
        rl.write("\x1b[0m")

        input = input.replace("\x1b[0m", "")
        await executeCommand(input)

        if (closed) break
        rl.prompt()
    }

    if (server != null) {
        server.close()
    }
})().catch(err => {
    if (err instanceof UserError) {
        printError(err.message)
        process.exit(1)
    } else if (err instanceof AxiosError) {
        printError(err.message + " at " + err.request.host + err.request.path)
        process.exit(1)
    }

    throw err
})
