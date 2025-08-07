/// <reference path="./.vscode/config.d.ts" />

import { github, project } from "ucpem"

project.use(github("bt7s7k7/Apsides").script("builder"))

project.prefix("src").res("youTubeArchive")
