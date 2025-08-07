import { Project } from "./Project"
import { UserError } from "./UserError"

let _project: Project | null = null

export function setActiveProject(project: Project) {
    _project = project
}

export function useProject() {
    if (_project == null) throw new UserError("No project loaded")
    return _project
}
