/// <reference path="./.vscode/config.d.ts" />

import { github, project } from "ucpem"

project.prefix("src").res("youtubeArchive",
    github("bt7s7k7/MiniML").res("cli"),
)

project.use(github("bt7s7k7/Apsides").script("builder"))

