import { WebSocket } from "ws";
import { AddMessageSchema, CreateSessionSchema, CreateWorkspaceSchema, type IncomingMessageType, type OutgoingMessageType } from "commons/types";
import { SessionModel, WorkspaceModel } from "db/client";
 import { query } from "@anthropic-ai/claude-agent-sdk";
import mongoose from "mongoose";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export class User {
    private socket : WebSocket;
    public id:string;

    constructor(id:string, socket: WebSocket){
        this.socket = socket
        this.id = id
    }

    async sendMessage(payload:OutgoingMessageType){
        this.socket.send(JSON.stringify(payload))
    }

    async handleIncomingMessage(msg: IncomingMessageType): Promise<OutgoingMessageType>{
        if(msg.type === "create-workspace"){
            const {success,data} = CreateWorkspaceSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect Workspace Schema")
            }

            if(!isAbsolute(data.path) || !existsSync(data.path) || !statSync(data.path).isDirectory()){
                throw new Error(`Workspace path must be an absolute path to an existing directory: ${data.path}`)
            }

            const workspace = await WorkspaceModel.create({
                path: data.path,
                name:data.path.split("/").pop()
            })

            return {
                type: "workspace-created",
                payload: { id: workspace._id.toString() }
            }
        }

        if(msg.type === "create-session"){
            const {success,data} = CreateSessionSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect session schema")
            }

            const session = await SessionModel.create({
                workspace: [data.workspaceId],
                conversation: []
            })

            return {
                type: "session-created",
                payload: { id: session._id.toString() }
            }
        }

        if(msg.type === "add-message"){
            const {success,data} = AddMessageSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect message schema")
            }

            const session = await SessionModel.findById(new mongoose.Types.ObjectId(data.sessionId))
           
            if(!session){
                throw new Error("Session not found")
            }

             const workspace = await WorkspaceModel.findOne({
                _id : session?.workspace
            })

            const result = await SessionModel.updateOne({ _id: data.sessionId},{$push:{conversation:{role:"user",payload:{message:data.message}}}})
            if(result.matchedCount === 0){
                throw new Error("Session not found")
            }


            // ponytail: tool calls collected per-turn, not persisted incrementally
            // (fine for a single request/response cycle; stream them live if turns get long)
            const toolCalls: { name: string; input: unknown }[] = [];

              // Agentic loop: streams messages as Claude works
            for await (const message of query({
            prompt: msg.payload.message,
            options: {
                cwd : workspace?.path || process.cwd(),
                allowedTools: ["Read", "Edit", "Glob"],
                resume: session.anthropicSessionId ? session.anthropicSessionId : undefined,
                permissionMode: "acceptEdits", // Auto-approve file edits
                includePartialMessages: true
            }
            })) {
            if (message.type === "stream_event") {
                const event = message.event;
                if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                    this.sendMessage({
                        type: "assistant-message-delta",
                        payload: { sessionId: data.sessionId, text: event.delta.text }
                    })
                }
            } else if (message.type === "assistant" && message.message?.content) {


                for (const block of message.message.content) {
                if ("text" in block) {
                    console.log(block.text); // Claude's reasoning
                } else if ("name" in block) {
                    console.log(`Tool: ${block.name}`); // Tool being called
                    toolCalls.push({ name: block.name, input: "input" in block ? block.input : undefined });
                }
                }
            } else if (message.type === "result") {
                console.log(`Done: ${message.subtype}`); // Final result
                if(!session.anthropicSessionId){
                    session.anthropicSessionId = message.session_id;
                    await session.save();
                }

                if(message.subtype === "success"){
                    console.log(message.result)
                    const assistantPayload = { message: message.result, toolCalls };
                    this.sendMessage({
                        type: "assistant-message",
                        payload: assistantPayload
                    })
                    await SessionModel.updateOne({ _id: data.sessionId},{$push:{conversation:{role:"assistant",payload:assistantPayload}}})
                }
            }
            }


            return {
                type: "message-added",
                payload: { id: data.sessionId }
            }
        }

       
       

       

        throw new Error("Unhandled message type")
    }
}