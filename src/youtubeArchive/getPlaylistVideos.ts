import axios from "axios"
import { printInfo } from "./print"

const _API_BASE_URL = "https://www.googleapis.com/youtube/v3"

/**
 * Represents the overall response from the 'playlistItems.list' API call.
 */
export interface PlaylistItemsResponse {
    kind: string
    etag: string
    nextPageToken?: string // This property is optional, as it won't be present on the last page.
    items: PlaylistItem[]
    pageInfo: PageInfo
}

/**
 * Represents a single item (video) in the playlist response.
 */
export interface PlaylistItem {
    kind: string
    etag: string
    id: string
    snippet: Snippet
    // Other parts like 'contentDetails' or 'status' would be added here
    // if you requested them in the API call.
}

/**
 * The 'snippet' part of a playlist item, containing the main video details.
 */
export interface Snippet {
    publishedAt: string
    channelId: string
    title: string
    description: string
    thumbnails: Thumbnails
    channelTitle: string
    playlistId: string
    position: number
    resourceId: ResourceId
    videoOwnerChannelId: string
    videoOwnerChannelTitle: string
}

/**
 * Details about the resource (video) itself.
 */
export interface ResourceId {
    kind: string
    videoId: string
}

/**
 * Contains different thumbnail sizes for the video.
 */
export interface Thumbnails {
    default: Thumbnail
    medium: Thumbnail
    high: Thumbnail
    standard?: Thumbnail
    maxres?: Thumbnail
}

/**
 * Represents a single thumbnail image.
 */
export interface Thumbnail {
    url: string
    width: number
    height: number
}

/**
 * Information about the page of results.
 */
export interface PageInfo {
    totalResults: number
    resultsPerPage: number
}

export async function getPlaylistVideos(playlist: string, playlistId: string, apiKey: string) {
    const videos: Snippet[] = []

    let index = 1
    let nextPageToken: string | null | undefined = null
    do {
        printInfo(`[${playlist}] Downloading first ${index * 50} videos...`)
        const url: string = `${_API_BASE_URL}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50&key=${apiKey}${nextPageToken != null ? `&pageToken=${nextPageToken}` : ""}`
        const response = await axios.get<PlaylistItemsResponse>(url)

        videos.push(...response.data.items.map(item => item.snippet))

        nextPageToken = response.data.nextPageToken
    } while (nextPageToken != null)

    return videos
}
