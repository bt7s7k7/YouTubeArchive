export function convertSrtToVtt(source: string) {
    const result: string[] = [
        // VTT Header
        "WEBVTT",
        "",
    ]

    const inputLines = source.split("\n")
    for (let i = 0; i < inputLines.length;) {
        // Skip extra empty lines
        if (!inputLines[i]) {
            i++
            continue
        }

        // SRT Format:
        //   1. Caption index (discard)
        i++

        //   2. Timestamp
        const timestamp = inputLines[i++]

        result.push(timestamp
            // In VTT the fractional separator is "." instead of ","
            .replace(/,/g, "."),
        )

        //   3. Subtitle text (may be multiple lines)
        while (inputLines[i]) result.push(inputLines[i++])

        //   4. Blank line
        result.push("")
        i++
    }

    return result.join("\n")
}
