import { AxiosError } from "axios"
import { exec } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { Cli } from "./cli/Cli"
import { unreachable } from "./comTypes/util"
import { Type } from "./struct/Type"
import { getPlaylistVideos } from "./youtubeArchive/getPlaylistVideos"
import { Playlist } from "./youtubeArchive/Playlist"
import { print, printError, printInfo, printWarn } from "./youtubeArchive/print"
import { Project } from "./youtubeArchive/Project"
import { setActiveProject, useProject } from "./youtubeArchive/state"
import { UserError } from "./youtubeArchive/UserError"
import { downloadThumbnail, indexSourceDirectory, parseInfoFile } from "./youtubeArchive/VideoFileManager"
import { VideoInfo } from "./youtubeArchive/VideoInfo"


void (async () => {
    let closed = false
    let _tmp: string | null = null
    function getTempFolder() {
        return _tmp ??= mkdtempSync(join(tmpdir(), "archive.downloads."))
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
                path ??= process.cwd()
                setActiveProject(new Project(path))
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
                    url = url.match(/list=(\w+)/)![1]
                }

                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()

                label ??= "Playlist " + (playlistRegistry.playlists.length + 1)
                if (playlistRegistry.playlists.find(v => v.label == label)) {
                    printError("Duplicate playlist name")
                    return
                }

                playlistRegistry.playlists.push(new Playlist(url, label, []))
                await playlistRegistry.save()

                printInfo(`Added playlist "${label}"`)
            },
        })
        .addOption({
            name: "view", desc: "View playlist content",
            params: [
                ["index", Type.number],
            ],
            async callback(index) {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = playlistRegistry.playlists.at(index - 1)
                if (playlist == null) {
                    throw new UserError("Index outside range")
                }

                let i = 0
                for (const video of playlist.videos) {
                    i++
                    const msg = `${i.toString().padStart(3, " ")}. ${video.label}`
                    print(`${`${i.toString().padStart(3, " ")}. ${video.label}` + (video.file == null ? "\x1b[91m (Missing)\x1b[0m" : "")} \x1b[2mhttps://youtu.be/${video.id}\x1b[0m`)
                }

            },
        })
        .addOption({
            name: "sync", desc: "Synchronises the list of videos in each playlist",
            async callback() {
                const project = useProject()
                const playlistRegistry = await project.getPlaylistRegistry()
                const playlists = playlistRegistry.playlists
                const videoRegistry = await project.getVideoRegistry()
                const videos = videoRegistry.videos

                for (const playlist of playlists) {
                    const videoSnippets = await getPlaylistVideos(playlist.label, playlist.url, project.getToken())
                    const ids: string[] = []
                    for (const videoSnippet of videoSnippets) {
                        const id = videoSnippet.resourceId.videoId
                        ids.push(id)
                        let video = videos.get(id)

                        if (video == null) {
                            video = new VideoInfo({
                                id,
                                thumbnail: null,
                                label: videoSnippet.title,
                                publishedAt: videoSnippet.publishedAt,
                                channel: videoSnippet.channelTitle,
                                channelId: videoSnippet.channelId,
                            })

                            videoRegistry.addVideo(video)
                            video.thumbnail = await downloadThumbnail(videoSnippet.thumbnails.standard?.url ?? videoSnippet.thumbnails.high.url)
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
                            playlist.videos.push(video)
                        } else {
                            playlist.videos.splice(index + 1, 0, video)
                        }
                    }
                }

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

                for (const video of videoRegistry.videos.values()) {
                    if (video.file != null) continue

                    path ??= getTempFolder()
                    print(`Downloading "${video.label}"`)
                    let failed = false
                    await new Promise<void>((resolve) => exec(`yt-dlp --cookies-from-browser chrome "https://www.youtube.com/watch?v=${video.id}"`, { cwd: path! }, (error, stdout, stderr) => {
                        if (error) {
                            failed = true
                            printError(`Failed to download "${video.label}", ${stderr}`)
                        }
                        resolve()
                    }))

                    if (failed) continue

                    const { videoFiles } = await indexSourceDirectory(path)
                    const videoFile = videoFiles.get(video.id)
                    if (videoFile == null) {
                        printError(`Cannot find video file for "${video.id}"`)
                        continue
                    }

                    await videoFileManager.importVideoFile(video, videoFile)
                }

                await videoRegistry.save()
                if (path != null) {
                    await rm(path, { force: true, recursive: true })
                }

            },
        })
        .addOption({
            name: "legacy import", desc: "Imports video files from a legacy archive",
            params: [
                ["path", Type.string],
            ],
            async callback(path) {
                const { videoFiles } = await indexSourceDirectory(path)
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                for (const video of videoRegistry.videos.values()) {
                    if (video.file != null) continue
                    const videoFile = videoFiles.get(video.id)
                    if (videoFile != null) {
                        print(`Importing video "${video.label}"`)
                        await videoFileManager.importVideoFile(video, videoFile)
                    } else {
                        printError(`Cannot find video "${video.label}"`)
                    }
                }

                await videoRegistry.save()
            },
        })
        .addOption({
            name: "legacy list", desc: "Imports videos from a legacy archive into a playlist",
            params: [
                ["index", Type.number],
                ["path", Type.string],
            ],
            async callback(index, path) {
                const { videoFiles, infoFiles } = await indexSourceDirectory(path)
                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                const playlistRegistry = await project.getPlaylistRegistry()
                const playlist = playlistRegistry.playlists.at(index - 1)
                if (playlist == null) {
                    throw new UserError("Index outside range")
                }

                for (const [id, videoFile] of videoFiles) {
                    const infoFile = infoFiles.get(id)
                    let video = videoRegistry.videos.get(id)
                    if (video == null) {
                        if (infoFile == null) {
                            printError(`Skipped importing "${videoFile}" because it has nof info file`)
                            continue
                        }

                        print(`Importing video "${videoFile}"`)
                        video = await parseInfoFile(infoFile)
                        await videoFileManager.importVideoFile(video, videoFile)
                        videoRegistry.addVideo(video)
                    }

                    if (!playlist.videos.includes(video)) {
                        playlist.videos.push(video)
                    }
                }

                await videoRegistry.save()
                await playlistRegistry.save()
            },
        })
        .addOption({
            name: "wipe videos", desc: "Deletes all video files",
            async callback() {
                if ((await rl.question("Are you sure? [y/n]")) != "y\x1b[0m") {
                    printWarn("Operation aborted")
                    return
                }

                const project = useProject()
                const videoRegistry = await project.getVideoRegistry()
                const videoFileManager = await project.getVideoFileManager()

                await rm(videoFileManager.path, { recursive: true, force: true })
                for (const video of videoRegistry.videos.values()) {
                    video.file = null
                }

                await videoRegistry.save()
            },
        })


    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "\x1b[33m>\x1b[96m ",
        completer(line) {
            return [repl.autocomplete(line), line]
        },
    })

    async function executeCommand(input: string) {
        const args = input.split(" ")
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
    executeCommand("reload")

    rl.resume()
    rl.prompt()
    for await (let input of rl) {
        rl.write("\x1b[0m")

        input = input.replace("\x1b[0m", "")
        await executeCommand(input)

        if (closed) return
        rl.prompt()
    }
})().catch(err => {
    if (err instanceof UserError) {
        printError(err.message)
        process.exit(1)
    }

    throw err
})
