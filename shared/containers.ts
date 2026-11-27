/** A cheap first check, shared by the agent hooks and the runtime: only a command naming a container tool needs a closer look. */
export const mentionsContainerTool = (command: string) => /\b(?:docker|podman)(?:-compose)?(?:\.exe)?\b/i.test(command)
