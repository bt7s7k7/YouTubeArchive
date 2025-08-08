import { Struct } from "../struct/Struct"
import { Type } from "../struct/Type"


export class VideoInfo extends Struct.define("VideoInfo", {
    id: Type.string,
    channel: Type.string,
    channelId: Type.string,
    label: Type.string,
    file: Type.string.as(Type.nullable),
    captions: Type.string.as(Type.array).as(Type.nullable),
    publishedAt: Type.string,
    thumbnail: Type.string.as(Type.nullable),
}) { }
