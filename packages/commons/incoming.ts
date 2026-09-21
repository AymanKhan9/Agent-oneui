import z from "zod";

export const CreateWorkspaceSchema = z.object({
    path: z.string()
})

export type CreateWorkspaceSchemaType = z.infer<typeof CreateWorkspaceSchema>;


export const CreateSessionSchema = z.object({
    workspaceId : z.string()
})

export type CreateSessionSchemaType = z.infer<typeof CreateSessionSchema>


export const ModelOptions = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"] as const
export type ModelOption = typeof ModelOptions[number]

export const PermissionModeOptions = ["acceptEdits", "plan", "auto", "default"] as const
export type PermissionModeOption = typeof PermissionModeOptions[number]

// "default" is the SDK's real ask-before-every-action mode; every other mode
// here pre-approves this whole list via allowedTools so it never hangs waiting
// on a prompt nobody can answer
export const ToolOptions = ["Read", "Edit", "Write", "Glob", "Bash", "Grep", "WebSearch", "WebFetch", "Task"] as const
export type ToolOption = typeof ToolOptions[number]

export const AttachmentSchema = z.object({
    name: z.string(),
    mediaType: z.string(),
    dataBase64: z.string()
})

export type AttachmentSchemaType = z.infer<typeof AttachmentSchema>

export const AddMessageSchema = z.object({
    sessionId: z.string(),
    message: z.string(),
    model: z.enum(ModelOptions).optional(),
    permissionMode: z.enum(PermissionModeOptions).optional(),
    attachments: z.array(AttachmentSchema).max(4).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional()
})


export type AddMessageSchemaType = z.infer<typeof AddMessageSchema>

export const AddPluginSchema = z.object({
    workspaceId: z.string(),
    path: z.string()
})

export type AddPluginSchemaType = z.infer<typeof AddPluginSchema>

export const RemovePluginSchema = z.object({
    workspaceId: z.string(),
    path: z.string()
})

export type RemovePluginSchemaType = z.infer<typeof RemovePluginSchema>

export const UpdateToolsSchema = z.object({
    workspaceId: z.string(),
    enabledTools: z.array(z.enum(ToolOptions))
})

export type UpdateToolsSchemaType = z.infer<typeof UpdateToolsSchema>

export const McpServerConfigSchema = z.object({
    name: z.string(),
    type: z.enum(["http", "sse", "stdio"]),
    url: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional()
})

export type McpServerConfigType = z.infer<typeof McpServerConfigSchema>

export const AddMcpServerSchema = z.object({
    workspaceId: z.string(),
    server: McpServerConfigSchema
})

export type AddMcpServerSchemaType = z.infer<typeof AddMcpServerSchema>

export const RemoveMcpServerSchema = z.object({
    workspaceId: z.string(),
    name: z.string()
})

export type RemoveMcpServerSchemaType = z.infer<typeof RemoveMcpServerSchema>

export const ListFilesSchema = z.object({
    workspaceId: z.string(),
    subpath: z.string().optional()
})

export type ListFilesSchemaType = z.infer<typeof ListFilesSchema>

export const InterruptSchema = z.object({
    sessionId: z.string()
})

export type InterruptSchemaType = z.infer<typeof InterruptSchema>

export const PermissionResponseSchema = z.object({
    requestId: z.string(),
    allow: z.boolean()
})

export type PermissionResponseSchemaType = z.infer<typeof PermissionResponseSchema>

export const RewindFilesSchema = z.object({
    sessionId: z.string(),
    dryRun: z.boolean().optional()
})

export type RewindFilesSchemaType = z.infer<typeof RewindFilesSchema>

export const GetMcpStatusSchema = z.object({
    sessionId: z.string()
})

export type GetMcpStatusSchemaType = z.infer<typeof GetMcpStatusSchema>

export const UpdateSandboxSchema = z.object({
    workspaceId: z.string(),
    sandboxed: z.boolean()
})

export type UpdateSandboxSchemaType = z.infer<typeof UpdateSandboxSchema>

export const AddDirectorySchema = z.object({
    workspaceId: z.string(),
    path: z.string()
})

export type AddDirectorySchemaType = z.infer<typeof AddDirectorySchema>

export const RemoveDirectorySchema = z.object({
    workspaceId: z.string(),
    path: z.string()
})

export type RemoveDirectorySchemaType = z.infer<typeof RemoveDirectorySchema>

export type IncomingMessageType = {
    type: "create-workspace",
    payload: CreateWorkspaceSchemaType
} | {type: "create-session", payload:CreateSessionSchemaType}
  | {type:"add-message",payload: AddMessageSchemaType}
  | {type:"add-plugin",payload: AddPluginSchemaType}
  | {type:"remove-plugin",payload: RemovePluginSchemaType}
  | {type:"update-tools",payload: UpdateToolsSchemaType}
  | {type:"add-mcp-server",payload: AddMcpServerSchemaType}
  | {type:"remove-mcp-server",payload: RemoveMcpServerSchemaType}
  | {type:"list-files",payload: ListFilesSchemaType}
  | {type:"interrupt",payload: InterruptSchemaType}
  | {type:"permission-response",payload: PermissionResponseSchemaType}
  | {type:"rewind-files",payload: RewindFilesSchemaType}
  | {type:"get-mcp-status",payload: GetMcpStatusSchemaType}
  | {type:"update-sandbox",payload: UpdateSandboxSchemaType}
  | {type:"add-directory",payload: AddDirectorySchemaType}
  | {type:"remove-directory",payload: RemoveDirectorySchemaType}