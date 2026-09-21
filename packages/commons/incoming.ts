import z from "zod";

export const CreateWorkspaceSchema = z.object({
    path: z.string()
})

export type CreateWorkspaceSchemaType = z.infer<typeof CreateWorkspaceSchema>;


export const CreateSessionSchema = z.object({
    workspaceId : z.string()
})

export type CreateSessionSchemaType = z.infer<typeof CreateSessionSchema>


export const AddMessageSchema = z.object({
    sessionId: z.string(),
    message: z.string()
})


export type AddMessageSchemaType = z.infer<typeof AddMessageSchema>

export type IncomingMessageType = {
    type: "create-workspace",
    payload: CreateWorkspaceSchemaType
} | {type: "create-session", payload:CreateSessionSchemaType} | {type:"add-message",payload: AddMessageSchemaType}