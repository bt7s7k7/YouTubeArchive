// @ts-check

const { readFileSync, readdirSync } = require("node:fs")
const { join, relative } = require("node:path")

module.exports = {
    modifyOptions(/** @type {import("esbuild").BuildOptions} */ options) {
        (options.plugins ??= []).push({
            name: "server-files",
            setup(build) {

                const VIRTUAL_MODULE_NAME = "virtual:server-files"

                build.onResolve({ filter: /^virtual:server-files$/ }, () => {
                    return {
                        path: VIRTUAL_MODULE_NAME,
                        namespace: "server-files-ns",
                    }
                })

                build.onLoad({ filter: /.*/, namespace: "server-files-ns" }, () => {
                    /** @type {Record<string, string>} */
                    const result = {
                        "quick-front.js": readFileSync(join(__dirname, "node_modules/quick-front/dist/assets/quick-front.js"), "utf-8"),
                        "quick-front.css": readFileSync(join(__dirname, "node_modules/quick-front/dist/assets/main.css"), "utf-8"),
                    }

                    for (const entry of readdirSync(join(__dirname, "public"), { withFileTypes: true, recursive: true })) {
                        if (!entry.isFile()) continue
                        const fullPath = join(entry.path ?? entry.parentPath, entry.name)
                        const relativePath = relative(join(__dirname, "public"), fullPath)
                        result[relativePath] = readFileSync(fullPath, "utf-8")
                    }

                    return {
                        contents: `export default ` + JSON.stringify(result),
                        loader: "js",
                    }
                })
            },
        })
    },
}
