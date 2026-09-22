import z from "zod";

export const WorkspaceCreatedSchema = z.object({
    id: z.string()
})

export type WorkspaceCreatedSchemaType = z.infer<typeof WorkspaceCreatedSchema>;


export const SessionCreatedSchema = z.object({
    id : z.string()
})

export type SessionCreatedSchemaType = z.infer<typeof SessionCreatedSchema>


export const LoadedPluginSchema = z.object({
    name: z.string(),
    path: z.string(),
    version: z.string().optional(),
})

export type LoadedPluginSchemaType = z.infer<typeof LoadedPluginSchema>

export const ContextUsageSchema = z.object({
    totalTokens: z.number(),
    maxTokens: z.number(),
    percentage: z.number(),
})

export type ContextUsageSchemaType = z.infer<typeof ContextUsageSchema>

export const MessageAdded = z.object({
    id: z.string(),
    title: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    slashCommands: z.array(z.string()).optional(),
    loadedPlugins: z.array(LoadedPluginSchema).optional(),
    totalCostUsd: z.number().optional(),
    totalInputTokens: z.number().optional(),
    totalOutputTokens: z.number().optional(),
    contextUsage: ContextUsageSchema.optional(),
    maxTurns: z.number().optional(),
    maxBudgetUsd: z.number().optional(),
})


export type MessageAddedType = z.infer<typeof MessageAdded>

export const PluginPathsUpdated = z.object({
    workspaceId: z.string(),
    pluginPaths: z.array(z.string()),
})

export type PluginPathsUpdatedType = z.infer<typeof PluginPathsUpdated>

export const AssistantMessageAdded = z.any()

export type AssistantMessageAddedType = z.infer<typeof AssistantMessageAdded>

export const ErrorSchema = z.object({
    message: z.string()
})

export type ErrorSchemaType = z.infer<typeof ErrorSchema>

export const AssistantMessageDelta = z.object({
    sessionId: z.string(),
    text: z.string()
})

export type AssistantMessageDeltaType = z.infer<typeof AssistantMessageDelta>

export const CompactionSchema = z.object({
    sessionId: z.string(),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number(),
    postTokens: z.number().optional(),
})

export type CompactionSchemaType = z.infer<typeof CompactionSchema>

export const RewindResultSchema = z.object({
    sessionId: z.string(),
    canRewind: z.boolean(),
    error: z.string().optional(),
    filesChanged: z.array(z.string()).optional(),
    insertions: z.number().optional(),
    deletions: z.number().optional(),
    dryRun: z.boolean(),
})

export type RewindResultSchemaType = z.infer<typeof RewindResultSchema>

export type McpServerConfig = { name: string; type: "http" | "sse" | "stdio"; url?: string; command?: string; args?: string[] }

export type McpStatusEntry = { name: string; status: "connected" | "failed" | "needs-auth" | "pending" | "disabled"; error?: string; toolCount?: number }

export type AgentDefinition = { name: string; description: string; prompt: string; model?: string; tools?: string[] }

export type ElicitationRequestPayload = {
    sessionId: string; requestId: string; serverName: string; message: string;
    mode?: "form" | "url"; url?: string; requestedSchema?: Record<string, unknown>; title?: string;
}

export type UsageWindow = { utilization: number | null; resetsAt: string | null }

export type UsageInfoPayload = {
    sessionId: string;
    error?: string;
    account?: { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string };
    totalCostUsd?: number;
    fiveHour?: UsageWindow;
    sevenDay?: UsageWindow;
}

export type OutgoingMessageType = {
    type: "workspace-created",
    payload: WorkspaceCreatedSchemaType
} | {type: "session-created", payload:SessionCreatedSchemaType}
  | {type:"message-added",payload: MessageAddedType}
  | {type:"assistant-message",payload: AssistantMessageAddedType}
  | {type:"assistant-message-delta",payload: AssistantMessageDeltaType}
  | {type:"assistant-thinking-delta",payload: AssistantMessageDeltaType}
  | {type:"assistant-tool-progress",payload:{sessionId:string, toolCalls: ToolCall[]}}
  | {type:"error",payload: ErrorSchemaType}
  | {type:"plugin-paths-updated",payload: PluginPathsUpdatedType}
  | {type:"tools-updated",payload:{workspaceId:string, enabledTools:string[]}}
  | {type:"mcp-servers-updated",payload:{workspaceId:string, mcpServers: McpServerConfig[]}}
  | {type:"permission-request",payload:{sessionId:string, requestId:string, toolName:string, input:unknown, title?:string}}
  | {type:"compaction",payload: CompactionSchemaType}
  | {type:"rewind-result",payload: RewindResultSchemaType}
  | {type:"mcp-status",payload:{sessionId:string, servers: McpStatusEntry[]}}
  | {type:"sandbox-updated",payload:{workspaceId:string, sandboxed:boolean}}
  | {type:"directories-updated",payload:{workspaceId:string, additionalDirectories:string[]}}
  | {type:"agents-updated",payload:{workspaceId:string, agents: AgentDefinition[]}}
  | {type:"fallback-model-updated",payload:{workspaceId:string, fallbackModel:string}}
  | {type:"system-prompt-updated",payload:{workspaceId:string, systemPromptAppend:string}}
  | {type:"elicitation-request",payload: ElicitationRequestPayload}
  | {type:"task-notification",payload:{sessionId:string, taskId:string, status:"completed"|"failed"|"stopped", summary:string}}
  | {type:"usage-info",payload: UsageInfoPayload} |
{
    type:"init",
    workspaces: Workspace []
}


export type Workspace ={
    id: string,
    name: string,
    path:string,
    pluginPaths?: string[],
    enabledTools?: string[],
    mcpServers?: McpServerConfig[],
    sandboxed?: boolean,
    additionalDirectories?: string[],
    agents?: AgentDefinition[],
    fallbackModel?: string,
    systemPromptAppend?: string,
    sessions: Session[]
}

export type Session = {
    id : string,
    title?: string,
    model?: string,
    permissionMode?: string,
    slashCommands?: string[],
    loadedPlugins?: LoadedPluginSchemaType[],
    totalCostUsd?: number,
    totalInputTokens?: number,
    totalOutputTokens?: number,
    contextUsage?: ContextUsageSchemaType,
    maxTurns?: number,
    maxBudgetUsd?: number,
    messages: Message[]
}

export type ToolCall = { id: string; name: string; input: unknown; result?: string; isError?: boolean }

export type AttachmentMeta = { name: string; mediaType: string }

export type Message = {
    role: "user",
    payload : {
        message:string,
        attachments?: AttachmentMeta[]
    }
} | {
    role: "assistant",
    payload: {
        message: string,
        toolCalls?: ToolCall[],
        thinking?: string
    }
} | {
    role: "system",
    payload: { text: string }
}