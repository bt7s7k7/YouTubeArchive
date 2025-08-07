export function printError(msg: string) {
    process.stdout.write(`\x1b[91m${msg}\x1b[0m\n`)
}

export function printWarn(msg: string) {
    process.stdout.write(`\x1b[93m${msg}\x1b[0m\n`)
}

export function printInfo(msg: string) {
    process.stdout.write(`\x1b[96m${msg}\x1b[0m\n`)
}

export function print(msg: string) {
    process.stdout.write(`${msg}\n`)
}
