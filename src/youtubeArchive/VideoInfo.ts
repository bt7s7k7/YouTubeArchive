import { EMPTY_ARRAY } from "../comTypes/const"
import { autoFilter } from "../comTypes/util"
import { Struct } from "../struct/Struct"
import { Type } from "../struct/Type"

export class VideoInfo extends Struct.define("VideoInfo", {
    id: Type.string,
    channel: Type.string.as(Type.nullable),
    channelId: Type.string.as(Type.nullable),
    label: Type.string,
    file: Type.string.as(Type.nullable),
    captions: Type.string.as(Type.array).as(Type.nullable),
    publishedAt: Type.string,
    thumbnail: Type.string.as(Type.nullable),
    description: Type.string,
}) {
    public getCaptionsList() {
        return this.captions ? autoFilter(this.captions.map(file => file.match(/\.(\w+)\.vtt$/)?.[1])) : EMPTY_ARRAY as never
    }
}
