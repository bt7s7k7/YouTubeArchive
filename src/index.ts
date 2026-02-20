import { AxiosError } from "axios"
import { exec, ExecException, ProcessEnvOptions } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { inspect } from "node:util"
import { Cli } from "./cli/Cli"
import { GenericParser } from "./comTypes/GenericParser"
import { Readwrite } from "./comTypes/types"
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

    async function execPromise(command: string, options?: ProcessEnvOptions) {
        return new Promise<{ error: ExecException | null, stdout: string, stderr: string }>((resolve) => {
            exec(command, options ?? {}, (error, stdout, stderr) => {
                resolve({ error, stdout, stderr })
            })
        })
    }

    function downloadVideo(video: VideoInfo, path: string, { useCookies = false, subsOnly = false } = {}) {
        if (useCookies && subsOnly) unreachable()

        const command = useCookies ? (
            `yt-dlp --cookies-from-browser chrome "${video.getUrl()}"`
        ) : (
            subsOnly ? (
                `yt-dlp --write-subs --sub-langs ".*" --skip-download "${video.getUrl()}"`
            ) : (
                `yt-dlp --write-subs --sub-langs ".*" "${video.getUrl()}"`
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
                        const url = playlist.getUrl()
                        print(`  ${(i + 1).toString().padStart(2, " ")}. \x1b[92m${playlist.label}\x1b[0m \x1b[2m${playlist.videos.length} videos${url == null ? "" : ` (${url})`}\x1b[0m`)
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
                ["url", Type.string.as(Type.nullable)],
            ],
            options: {
                label: Type.string.as(Type.nullable),
            },
            async callback(url, { label }) {
                if (url != null && url.includes("list=")) {
                    url = url.match(/list=([\w-]+)/)![1]
                }

                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()

                label ??= "Playlist " + (playlistRegistry.playlists.length + 1)
                if (playlistRegistry.playlists.find(v => v.label == label)) {
                    printError("Duplicate playlist name")
                    return
                }

                playlistRegistry.playlists.push(new Playlist(makeRandomID(), url, label, [], new Map()))
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

                playlist.sourceId = url
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
            name: "playlist insert", desc: "Adds a video to a playlist or changes its index; if the reference video is specified, the video is placed after the reference",
            params: [
                ["playlist", Type.number],
                ["videoId", Type.string],
                ["referenceId", Type.string.as(Type.nullable)],
            ],
            options: {
                first: Type.boolean.as(Type.nullable),
            },
            async callback(playlistIndex, videoId, referenceId, { first }) {
                if (referenceId != null && first) throw new UserError(`Cannot specify both "first" and "referenceId"`)

                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = await getPlaylistByIndex(playlistIndex)

                const videoRegistry = await project.getVideoRegistry()
                const video = videoRegistry.videos.get(videoId)

                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                const referenceIndex = referenceId == null ? 0 : playlist.videos.findIndex(v => v.id == referenceId)
                if (referenceIndex == -1) {
                    throw new UserError("The specified reference video is not in the playlist")
                }

                const existingIndex = playlist.videos.findIndex(v => v.id == videoId)
                if (existingIndex != -1) {
                    playlistRegistry.removeVideoFromPlaylist(video, playlist)
                }

                if (first) {
                    playlistRegistry.insertVideoToPlaylist(video, playlist, 0)
                } else if (referenceId != null) {
                    playlistRegistry.insertVideoToPlaylist(video, playlist, referenceIndex + 1)
                } else {
                    playlistRegistry.addVideoToPlaylist(video, playlist)
                }

                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "playlist subtract", desc: "Removes a video from the playlist",
            params: [
                ["playlist", Type.number],
                ["videoId", Type.string],
            ],
            async callback(playlistIndex, videoId) {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = await getPlaylistByIndex(playlistIndex)

                const videoRegistry = await project.getVideoRegistry()
                const video = videoRegistry.videos.get(videoId)

                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                if (!playlistRegistry.removeVideoFromPlaylist(video, playlist)) {
                    throw new UserError("The specified video is not in the playlist")
                }

                await playlistRegistry.save()

            },
        })
        .addOption({
            name: "list", desc: "Prints videos in a playlist",
            params: [
                ["index", Type.number],
            ],
            async callback(index) {
                const playlist = await getPlaylistByIndex(index)

                let i = 0
                for (const video of playlist.videos) {
                    const label = playlist.labels.get(i)
                    if (label != null) {
                        for (const line of label.split("\n")) {
                            print(`\x1b[93m>>> ${line}\x1b[0m`)
                        }
                    }
                    i++
                    print(`${i.toString().padStart(3, " ")}. ${video.label}${video.file == null ? "\x1b[91m (Missing)\x1b[0m" : ""} \x1b[2m${video.getShortUrl()}\x1b[0m`)
                }

            },
        })
        .addOption({
            name: "orphans", desc: "List orphaned videos",
            async callback() {
                let i = 0
                for (const video of await getOrphanVideos()) {
                    i++
                    print(`${i.toString().padStart(3, " ")}. ${video.label}${video.file == null ? "\x1b[91m (Missing)\x1b[0m" : ""} \x1b[2m${video.getShortUrl()}\x1b[0m`)
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
                    print(`${i.toString().padStart(3, " ")}. ${video.label} \x1b[2m${video.getShortUrl()}\x1b[0m`)
                }
            },
        })
        .addOption({
            name: "missing thumbnails", desc: "List videos without thumbnails",
            async callback() {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                let i = 0
                for (const video of videoRegistry.videos.values()) {
                    if (video.thumbnail != null) continue
                    i++
                    print(`${i.toString().padStart(3, " ")}. ${video.label} \x1b[2m${video.getShortUrl()}\x1b[0m`)
                }

                if (i == 0) {
                    print("There are no videos with missing thumbnails")
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
                        // Playlist could not have an associated YouTube playlist
                        if (playlist.sourceId == null) return

                        const videoSnippets = await getPlaylistVideos(playlist.label, playlist.sourceId, project.getToken())
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

                            // If the playlist has labels, we want to add unsorted videos under the
                            // "New" label. If the label does not exists we need to create it, but
                            // if the playlist does not have labels at all, just add the video.

                            const labels = [...playlist.labels.entries()]
                            if (labels.length == 0) {
                                playlistRegistry.addVideoToPlaylist(video, playlist)
                                continue
                            }

                            const newIndex = labels.findIndex(([_, label]) => label == "New")
                            if (newIndex == -1) {
                                // Add the video and create the "New" label at its position
                                const index = playlistRegistry.addVideoToPlaylist(video, playlist)
                                playlist.labels.set(index, "New")
                                continue
                            }

                            const nextLabel = labels.at(newIndex + 1)
                            if (nextLabel == null) {
                                // The "New" label is last, just add the video to the end of the playlist
                                playlistRegistry.addVideoToPlaylist(video, playlist)
                                continue
                            }

                            // Insert the video before the next label's start (the end of the "New" label)
                            playlistRegistry.insertVideoToPlaylist(video, playlist, nextLabel[0])
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
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const playlistRegistry = await project.getPlaylistRegistry()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Cannot find selected video")
                }

                if (!await areYouSure()) return

                await deleteVideo(video)

                await videoRegistry.save()
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "video file delete", desc: "Deletes a video file, keeping the video metadata",
            params: [
                ["id", Type.string],
            ],
            async callback(id) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Cannot find selected video")
                }

                if (!await areYouSure()) return

                await videoFileManager.wipeVideoFiles(video)

                await videoRegistry.save()
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
            name: "video external add", desc: "Adds a new video not from YouTube",
            params: [
                ["id", Type.string],
                ["url", Type.string],
            ],
            options: VIDEO_PROPERTIES,
            async callback(id, url, properties) {
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()

                if (videoRegistry.videos.has(id)) {
                    throw new UserError("Video with the specified ID already exists")
                }

                validateVideoProperties(properties)
                const tumblrFormat = url.match(/^https:\/\/www.tumblr.com\/([\w-]+)\/([\w-]+)/)
                if (tumblrFormat) {
                    properties.channel ??= tumblrFormat[1]
                    properties.channelId ??= `https://www.tumblr.com/${tumblrFormat[1]}`
                }

                const video = new VideoInfo({
                    id, url,
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
            name: "video thumbnail generate", desc: "Generates a thumbnail of a video from the frame at timestamp",
            params: [
                ["id", Type.string],
                ["timestamp", Type.string.as(Type.nullable)],
            ],
            async callback(id, timestampString) {
                timestampString ??= "00:00:00"
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const video = videoRegistry.videos.get(id)
                if (video == null) {
                    throw new UserError("Video with the specified ID does not exist")
                }

                if (video.file == null) {
                    throw new UserError("The selected video does not have video data")
                }

                if (video.thumbnail != null) {
                    print("The selected video already has a thumbnail. It will be replaced.")
                    if (!await areYouSure()) return
                }

                const thumbnailFile = join(getTempFolder(), `${video.id}.generated.jpg`)
                const thumbnailFileResized = join(getTempFolder(), `${video.id}.resized.jpg`)
                const videoFile = join(videoFileManager.path, video.file)

                const ffmpegResult = await execPromise(`ffmpeg -y -ss ${JSON.stringify(timestampString)} -i ${JSON.stringify(videoFile)} -frames:v 1 ${JSON.stringify(thumbnailFile)}`)
                if (ffmpegResult.error) {
                    throw new UserError(`Failed to execute FFmpeg: ${ffmpegResult.error.message}`)
                }

                const magicResult = await execPromise(`magick ${thumbnailFile} -resize '640x360>' -gravity center -background black -extent 640x360 ${thumbnailFileResized}`)
                if (magicResult.error) {
                    throw new UserError(`Failed to execute ImageMagick: ${magicResult.error.message}`)
                }

                const thumbnailData = await readFile(thumbnailFileResized)
                video.thumbnail = `data:image/jpeg;base64,` + thumbnailData.toString("base64")

                await videoRegistry.save()
                await rm(getTempFolder(), { force: true, recursive: true })
                _tmp = null
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
                arg += parser.readUntil("\"").replace(/(?<!\\)\\n/g, "\n").replace(/\\\\/g, "\\")
                parser.index++
                continue
            }

            if (parser.consume("'")) {
                arg += parser.readUntil("'").replace(/(?<!\\)\\n/g, "\n").replace(/\\\\/g, "\\")
                parser.index++
                continue
            }
        }

        if (arg.length > 0) args.push(arg)
        return args
    }

    async function autocompleteVideoId(command: Cli.Command, match: RegExpMatchArray, result: string[]) {
        const prefix = match[1]
        const idStart = match[2]
        const videoRegistry = await useProject().getVideoRegistry()
        const videos = [...videoRegistry.videos.keys()].filter(v => v.startsWith(idStart))
        result.push(...videos.map(v => `${prefix}${v}`))
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[33m>\x1b[96m ",
        async completer(line) {
            const result = repl.autocomplete(line)

            const args = parseArgs(line)
            const match = repl.findCommand(args)
            if (match) {
                const command = match[1]
                if (command.fullName.startsWith("video")) {
                    const idMatch = line.match(new RegExp(`^(${command.fullName} )([\\w-]+)$`))
                    if (idMatch) autocompleteVideoId(command, idMatch, result)
                } else if (command.fullName.startsWith("playlist insert")) {
                    const referenceMatch = line.match(new RegExp(`^(${command.fullName} \\d+ [\\w-]+ )([\\w-]+)$`))
                    if (referenceMatch) {
                        autocompleteVideoId(command, referenceMatch, result)
                    } else {
                        const idMatch = line.match(new RegExp(`^(${command.fullName} \\d+ )([\\w-]+)$`))
                        if (idMatch) autocompleteVideoId(command, idMatch, result)
                    }
                } else if (command.fullName.startsWith("playlist subtract")) {
                    const idMatch = line.match(new RegExp(`^(${command.fullName} \\d+ )([\\w-]+)$`))
                    if (idMatch) autocompleteVideoId(command, idMatch, result)
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

    rl.on("SIGINT", () => {
        process.stdout.write("\n");
        (rl as Readwrite<typeof rl>).line = ""
        rl.prompt()
    })

    rl.resume()
    rl.prompt()
    for await (let input of rl) {
        process.stdout.write("\x1b[0m")

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
