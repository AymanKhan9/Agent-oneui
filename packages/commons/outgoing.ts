import z from "zod";

export const WorkspaceCreatedSchema = z.object({
    id: z.string()
})

export type WorkspaceCreatedSchemaType = z.infer<typeof WorkspaceCreatedSchema>;


export const SessionCreatedSchema = z.object({
    id : z.string()
})

export type SessionCreatedSchemaType = z.infer<typeof SessionCreatedSchema>


export const MessageAdded = z.object({
    id: z.string(),
    
})


export type MessageAddedType = z.infer<typeof MessageAdded>

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

export type OutgoingMessageType = {
    type: "workspace-created",
    payload: WorkspaceCreatedSchemaType
} | {type: "session-created", payload:SessionCreatedSchemaType} | {type:"message-added",payload: MessageAddedType} | {type:"assistant-message",payload: AssistantMessageAddedType} | {type:"assistant-message-delta",payload: AssistantMessageDeltaType} | {type:"error",payload: ErrorSchemaType} |
{
    type:"init",
    workspaces: Workspace []
}


export type Workspace ={
    id: string,
    name: string,
    path:string,
    sessions: Session[]
}

export type Session = {
    id : string,
    messages: Message[]
}

export type ToolCall = { name: string; input: unknown }

export type Message = {
    role: "user",
    payload : {
        message:string
    }
} | {
    role: "assistant",
    payload: {
        message: string,
        toolCalls?: ToolCall[]
    }
}