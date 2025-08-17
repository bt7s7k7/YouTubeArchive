# YouTube Archive

This application allows you to archive your YouTube playlists and later play archived videos via a web interface.

## Features

  - **Automatic fetching of playlist videos**
  - **Deduplication of videos** present in multiple playlists
  - **Video captions**
  - **Video metadata** (channel, published date, description, thumbnail)
  - **Web interface** for playlist browsing and video playback
  - **Video file download** using [yt-dlp](https://github.com/yt-dlp/yt-dlp)

## Terminology

This application works with an **archive project**, which is a folder on your computer. Each archive includes a video metadata file `videos.json` and playlist files `<name>.ini`. All video and caption files are stored in a `videos` subfolder.

There is a distinction between a **video** and a **video file**. A video is a set of metadata that may or may not have an associated video file. Video metadata are imported/downloaded using `fetch` operations. Actual video files are imported/downloaded using `pull` operations. 

There is a concept of a **legacy archive**, which is a folder of video files downloaded using yt-dlp. This application can associate video files from such a legacy archive to videos using the `legacy pull` command. Additionally, if the `--write-info-json` argument was used, these videos can be imported into a playlist using the `legacy fetch` command.

Videos that are included in the archive but not associated with any playlist are referred to as "**orphan**" videos.

## Usage

  1. To open an archive, either run this application in the archive folder or provide the path as the first argument. No action is required to create an archive; all data files will be created when they are needed.
  2. If you wish to fetch any data from YouTube, create a `token.txt` file in the archive folder and include a YouTube API token. 
  3. Upon launching the application, enter commands into the CLI.

## Playlist files

Playlist files associate videos with a playlist. The playlist name is acquired from the filename. To edit the playlist label or add/remove/reorder associated videos, simply edit the playlist file. You can run the `reload` command to update playlist information without restarting the application. The playlist file contains the `id` field — this is a unique identifier that is used to refer to a playlist from the Web UI.

An example playlist file is provided below:

```ini
id = 8Cr9GMvKR46Rv251-0_sLg
url = PL_01GZnwpJ60tEJgRFNiBc4GZch3XBoeR

-a1IVRXHjPg intrepid heroes pvp combat
dQcjb446XYc [MV] Perception Check - Tom Cardy
8KdpyqlOH8M TechDif Animated: Tartar Sauce Rustling | Citation Needed
Rn3CU3mluMw Red Signal Animatic
f3GokYBWZpU Grand Scam Pasta
```

When reading the playlist file, only the video ID is considered. The video label is only included to help you edit the playlist and can be changed or omitted without effect.

## Commands

> When a command requires an `index` argument, this refers to a playlist index. To view playlist indices use the `status` command.

```
  quit             - Stops the application
  help             - Prints help text
  reload           - Clears cache to reload config files
    --path: string | null
  status           - Prints the status of the current project
  playlist add     - Adds a playlist to be archived
    <url>: string, --label: string | null
  playlist set url - Changes the url of the selected playlist
    <index>: number, <url>: string
  playlist delete  - Deletes a playlist
    <index>: number
  view             - View orphaned videos
    <index>: number
  orphans          - List orphaned videos
  orphans delete   - Deletes all orphan videos
  missing          - List videos without video files
  fetch            - Fetches the list of videos in each playlist
  pull             - Downloads missing video files
  pull captions    - Downloads missing video captions
  legacy pull      - Pulls video files from a legacy archive
    <path>: string
  legacy fetch     - Imports videos from a legacy archive into a playlist
    <index>: number, <path>: string
  wipe videos      - Deletes all video files
  video            - Displays video metadata
    <id>: string
  video delete     - Deletes a video
    <id>: string
  video add        - Adds a new video
    <id>: string, --label: string | null, --description: string | null, --publishedAt: string | null, --channel: string | null, --channelId: string | null
  video update     - Allows you to update video metadata
    <id>: string, --label: string | null, --description: string | null, --publishedAt: string | null, --channel: string | null, --channelId: string | null
  video fetch      - Fetches metadata for a video
    <id>: string
  flush            - Rewrite all data files to a normalized form
```

## Web interface

This application provides a web interface for playlist browsing and video playback. This interface is read-only; there is no danger in exposing it (other than copyright infringement).

To enable the web interface, create a `server.json` file in the archive folder. This file allows for server configuration. An example server file is provided below:

```json
{
    "port": 6115
}
```

The web interface will automatically start when the application is run and close when the application is terminated. Currently, there is no support for running it in the background.

Example screenshots of the Web UI are provided below:

<img width="1003" height="534" alt="Screenshot of the Web UI index page. The page displays a list of playlists and a link to show all videos. Each displayed playlist shows the playlist label, the count of associated videos and the thumbnail of the first video in the playlist." src="https://github.com/user-attachments/assets/a05f54e0-f62d-4baf-96e3-0367e7f03331" />

<div align="center">Web UI index</div>

&nbsp;

<img width="1072" height="718" alt="Screenshot of a playlist page. The page displays the video count and a list of videos. Each video has shows its thumbnail, label, author and how long ago it was published." src="https://github.com/user-attachments/assets/26d7f078-006d-42e6-82e6-aac6ecc52121" />
<div align="center">Playlist page</div>

&nbsp;

<img width="1076" height="869" alt="Screenshot of a video page. The page displays a video player, its label, its author, how long ago it was published and its description." src="https://github.com/user-attachments/assets/1d736ee6-1a41-4d47-b187-3588f36b4cc9" />
<div align="center">Video page</div>
