import { WebSocket } from "ws";
import {
    AddDirectorySchema, AddMcpServerSchema, AddMessageSchema, AddPluginSchema, CreateSessionSchema, CreateWorkspaceSchema,
    InterruptSchema, ListFilesSchema, PermissionResponseSchema, RemoveDirectorySchema, RemoveMcpServerSchema, RemovePluginSchema,
    GetMcpStatusSchema, RewindFilesSchema, UpdateSandboxSchema, UpdateToolsSchema, ToolOptions,
    type AttachmentSchemaType, type IncomingMessageType, type McpServerConfigType, type OutgoingMessageType
} from "commons/types";
import { SessionModel, WorkspaceModel } from "db/client";
import { query, type PermissionMode, type PermissionResult, type Query } from "@anthropic-ai/claude-agent-sdk";
import mongoose from "mongoose";
import { existsSync, statSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const DEFAULT_ENABLED_TOOLS = ["Read", "Edit", "Write", "Glob", "Bash"];

// ponytail: title is the first message truncated at a word boundary, not an
// LLM-generated summary — upgrade to a real title-generation call if this reads too raw
function deriveSessionTitle(message: string): string {
    const firstLine = message.trim().split("\n")[0] ?? "";
    if (firstLine.length <= 60) return firstLine || "Untitled session";
    const truncated = firstLine.slice(0, 60);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

// matches the SDK's ContentBlockParam union structurally
function contentBlocksFor(message: string, attachments?: AttachmentSchemaType[]) {
    const content: any[] = [];
    if (message) content.push({ type: "text", text: message });
    for (const a of attachments ?? []) {
        if (a.mediaType.startsWith("image/")) {
            content.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.dataBase64 } });
        } else if (a.mediaType === "application/pdf") {
            content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.dataBase64 } });
        }
    }
    return content;
}

// A never-ending async generator fed via push(): this is what "streaming
// input mode" actually means to the SDK — one open input channel for the
// whole session's lifetime, not one generator per turn. (Query.streamInput()
// looks like a public "send more input" API but is documented as "used
// internally for multi-turn conversations" — calling it after the initial
// prompt generator completes doesn't reliably deliver the message.)
function createPushableStream() {
    const queue: any[] = [];
    let notify: (() => void) | null = null;

    async function* stream() {
        while (true) {
            if (queue.length > 0) {
                yield queue.shift();
            } else {
                await new Promise<void>(resolve => { notify = resolve; });
            }
        }
    }

    // returns the uuid it assigned this turn's message — the CLI never echoes
    // a plain (non-tool-result) "user" message back on its output stream, so
    // this is the only way to get the id rewindFiles() needs to target it
    function push(message: string, attachments?: AttachmentSchemaType[]): string {
        const uuid = crypto.randomUUID();
        queue.push({
            type: "user" as const,
            message: { role: "user" as const, content: contentBlocksFor(message, attachments) },
            parent_tool_use_id: null,
            uuid,
        });
        if (notify) {
            const n = notify;
            notify = null;
            n();
        }
        return uuid;
    }

    return { stream: stream(), push };
}

// {name,type,url,command,args}[] -> the Record<name, McpServerConfig> shape the SDK wants
function buildMcpServers(servers?: McpServerConfigType[]) {
    if (!servers || servers.length === 0) return undefined;
    const out: Record<string, any> = {};
    for (const s of servers) {
        out[s.name] = s.type === "stdio"
            ? { type: "stdio", command: s.command, args: s.args }
            : { type: s.type, url: s.url };
    }
    return out;
}

// Tools/plugins/MCP servers/sandboxing/extra dirs/turn+budget caps are only
// configurable at process-start time (no live "setTools" control request
// exists) — this fingerprint tells us when a session's runtime is stale and
// needs to be torn down and recreated (via `resume`) instead of just
// streaming the next message into it.
function configFingerprint(config: {
    enabledTools: string[]; pluginPaths: string[] | undefined; mcpServers: unknown;
    sandboxed: boolean | undefined; additionalDirectories: string[] | undefined;
    maxTurns: number | undefined; maxBudgetUsd: number | undefined;
}) {
    return JSON.stringify({
        enabledTools: config.enabledTools, pluginPaths: config.pluginPaths ?? [], mcpServers: config.mcpServers ?? [],
        sandboxed: config.sandboxed ?? false, additionalDirectories: config.additionalDirectories ?? [],
        maxTurns: config.maxTurns ?? null, maxBudgetUsd: config.maxBudgetUsd ?? null,
    });
}

type ToolCallState = { id: string; name: string; input: unknown; result?: string; isError?: boolean };

// per-turn accumulators + the promise the "add-message" handler is awaiting —
// handed off to the session's persistent consumer loop, which resolves it
// once this turn's "result" message arrives
type TurnState = {
    resolve: (payload: OutgoingMessageType) => void;
    reject: (err: unknown) => void;
    session: mongoose.Document & { [key: string]: any };
    title?: string;
    model?: string;
    permissionMode: PermissionMode;
    maxTurns?: number;
    maxBudgetUsd?: number;
    toolCalls: ToolCallState[];
    toolCallsById: Map<string, ToolCallState>;
    thinkingText: string;
    slashCommands?: string[];
    loadedPlugins?: { name: string; path: string; version?: string }[];
};

// one persistent SDK subprocess per session, kept alive across turns so
// control requests (interrupt/setModel/setPermissionMode/rewindFiles) work
type SessionRuntime = {
    query: Query;
    push: (message: string, attachments?: AttachmentSchemaType[]) => string;
    fingerprint: string;
    model?: string;
    // mutable box closed over by canUseTool — permissionMode can change
    // live (Query.setPermissionMode) without recreating the subprocess
    liveState: { permissionMode: PermissionMode };
    // uuid of the most recent real user turn (not a synthetic tool_result
    // message), the checkpoint rewindFiles() rewinds back to
    lastUserMessageUuid?: string;
};

export class User {
    private socket : WebSocket;
    public id:string;
    // requestId -> resolver, for tool calls awaiting a live permission decision
    // ("default"/ask permission mode only — every other mode auto-allows in canUseTool below)
    private pendingPermissions = new Map<string, (result: PermissionResult) => void>();
    // sessionId -> this connection's live subprocess for that session
    private sessionRuntimes = new Map<string, SessionRuntime>();
    // sessionId -> the turn currently in flight on that session (one at a time,
    // matching the frontend which blocks input while a turn is pending)
    // FIFO per session, not a single slot: interrupt resolves the front turn
    // early while its real "result" message is still in flight on the SDK's
    // output stream, so a naive single-slot map would let that late straggler
    // get misattributed to whatever turn started next. staleResultsExpected
    // tells the "result" handler to silently discard exactly that many
    // late/aborted results instead of matching them to the wrong turn.
    private turnQueues = new Map<string, TurnState[]>();
    private staleResultsExpected = new Map<string, number>();

    constructor(id:string, socket: WebSocket){
        this.socket = socket
        this.id = id
    }

    async sendMessage(payload:OutgoingMessageType){
        this.socket.send(JSON.stringify(payload))
    }

    // called on websocket close — leaving these subprocesses running would leak them
    closeAllSessions(){
        for (const runtime of this.sessionRuntimes.values()) {
            try { runtime.query.close() } catch {}
        }
        this.sessionRuntimes.clear();
    }

    // runs for the lifetime of a session's subprocess, dispatching every
    // message across however many turns get streamed into it
    private async consumeSession(sessionId: string, queryObj: Query){
        try {
            for await (const message of queryObj) {
                const turn = this.turnQueues.get(sessionId)?.[0];

                if (message.type === "stream_event") {
                    if (!turn) continue;
                    const event = message.event;
                    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                        this.sendMessage({
                            type: "assistant-message-delta",
                            payload: { sessionId, text: event.delta.text }
                        })
                    } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
                        turn.thinkingText += event.delta.thinking;
                        this.sendMessage({
                            type: "assistant-thinking-delta",
                            payload: { sessionId, text: event.delta.thinking }
                        })
                    }
                } else if (message.type === "system" && message.subtype === "compact_boundary") {
                    const { trigger, pre_tokens, post_tokens } = message.compact_metadata;
                    this.sendMessage({
                        type: "compaction",
                        payload: { sessionId, trigger, preTokens: pre_tokens, postTokens: post_tokens }
                    })
                    const text = `Context compacted (${trigger}) — ${pre_tokens.toLocaleString()} → ${post_tokens?.toLocaleString() ?? "?"} tokens`;
                    await SessionModel.updateOne({ _id: sessionId }, { $push: { conversation: { role: "system", payload: { text } } } })
                } else if (message.type === "system" && message.subtype === "init") {
                    if (!turn) continue;
                    turn.slashCommands = message.slash_commands;
                    if (JSON.stringify(turn.slashCommands) !== JSON.stringify(turn.session.slashCommands)) {
                        turn.session.slashCommands = turn.slashCommands;
                        await turn.session.save();
                    }
                    turn.loadedPlugins = message.plugins;
                    if (JSON.stringify(turn.loadedPlugins) !== JSON.stringify(turn.session.loadedPlugins)) {
                        turn.session.loadedPlugins = turn.loadedPlugins as any;
                        await turn.session.save();
                    }
                } else if (message.type === "system" && message.subtype === "commands_changed") {
                    if (!turn) continue;
                    turn.slashCommands = message.commands.map(c => c.name);
                    if (JSON.stringify(turn.slashCommands) !== JSON.stringify(turn.session.slashCommands)) {
                        turn.session.slashCommands = turn.slashCommands;
                        await turn.session.save();
                    }
                } else if (message.type === "system" && message.subtype === "local_command_output") {
                    // e.g. /usage, /cost — answered locally, no model turn involved
                    const assistantPayload = { message: message.content, toolCalls: [] as ToolCallState[] };
                    this.sendMessage({ type: "assistant-message", payload: assistantPayload })
                    await SessionModel.updateOne({ _id: sessionId },{$push:{conversation:{role:"assistant",payload:assistantPayload}}})
                } else if (message.type === "assistant" && message.message?.content) {
                    if (!turn) continue;
                    for (const block of message.message.content) {
                        if ("name" in block && "id" in block) {
                            const call = { id: block.id, name: block.name, input: "input" in block ? block.input : undefined };
                            turn.toolCalls.push(call);
                            turn.toolCallsById.set(block.id, call);
                            this.sendMessage({
                                type: "assistant-tool-progress",
                                payload: { sessionId, toolCalls: [...turn.toolCalls] }
                            })
                        }
                    }
                } else if (message.type === "user" && Array.isArray(message.message?.content)) {
                    if (turn) {
                        for (const block of message.message.content) {
                            if (block.type === "tool_result" && "tool_use_id" in block) {
                                const call = turn.toolCallsById.get(block.tool_use_id);
                                if (!call) continue;
                                const content = block.content;
                                call.result = typeof content === "string"
                                    ? content
                                    : Array.isArray(content)
                                        ? content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n")
                                        : undefined;
                                call.isError = block.is_error === true;
                                this.sendMessage({
                                    type: "assistant-tool-progress",
                                    payload: { sessionId, toolCalls: [...turn.toolCalls] }
                                })
                            }
                        }
                    }
                } else if (message.type === "result") {
                    const stale = this.staleResultsExpected.get(sessionId) ?? 0;
                    if (stale > 0) {
                        // straggler from a turn interrupt() already resolved early —
                        // the queue has moved on, don't touch it
                        this.staleResultsExpected.set(sessionId, stale - 1);
                        continue;
                    }

                    const queue = this.turnQueues.get(sessionId);
                    const dequeued = queue?.shift();
                    if (!dequeued) continue;
                    const turn = dequeued;

                    if (turn.session.anthropicSessionId !== message.session_id) {
                        turn.session.anthropicSessionId = message.session_id;
                        await turn.session.save();
                    }

                    if (message.subtype !== "success") {
                        turn.reject(new Error(`Turn ended without a result (${message.subtype})`));
                        continue;
                    }

                    const totalCostUsd = Math.round(((turn.session.totalCostUsd ?? 0) + message.total_cost_usd) * 1e6) / 1e6;
                    const totalInputTokens = (turn.session.totalInputTokens ?? 0) + message.usage.input_tokens;
                    const totalOutputTokens = (turn.session.totalOutputTokens ?? 0) + message.usage.output_tokens;
                    turn.session.totalCostUsd = totalCostUsd;
                    turn.session.totalInputTokens = totalInputTokens;
                    turn.session.totalOutputTokens = totalOutputTokens;
                    await turn.session.save();

                    const assistantPayload = { message: message.result, toolCalls: turn.toolCalls, thinking: turn.thinkingText || undefined };
                    this.sendMessage({ type: "assistant-message", payload: assistantPayload })
                    await SessionModel.updateOne({ _id: sessionId },{$push:{conversation:{role:"assistant",payload:assistantPayload}}})

                    // piggyback on the turn's own round trip instead of a separate
                    // request — this is exactly when "how much room is left" matters
                    const usage = await queryObj.getContextUsage().catch(() => undefined);
                    const contextUsage = usage
                        ? { totalTokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage }
                        : undefined;

                    turn.resolve({
                        type: "message-added",
                        payload: {
                            id: sessionId, title: turn.title, model: turn.model, permissionMode: turn.permissionMode,
                            maxTurns: turn.maxTurns, maxBudgetUsd: turn.maxBudgetUsd,
                            slashCommands: turn.slashCommands, loadedPlugins: turn.loadedPlugins,
                            totalCostUsd, totalInputTokens, totalOutputTokens, contextUsage
                        }
                    });
                }
            }
        } catch (err) {
            const queue = this.turnQueues.get(sessionId);
            this.turnQueues.delete(sessionId);
            for (const turn of queue ?? []) turn.reject(err);
        } finally {
            this.sessionRuntimes.delete(sessionId);
        }
    }

    async handleIncomingMessage(msg: IncomingMessageType): Promise<OutgoingMessageType | undefined>{
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

        if(msg.type === "add-plugin"){
            const {success,data} = AddPluginSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect plugin schema")
            }

            if(!isAbsolute(data.path) || !existsSync(data.path) || !statSync(data.path).isDirectory()){
                throw new Error(`Plugin path must be an absolute path to an existing directory: ${data.path}`)
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            const pluginPaths = workspace.pluginPaths ?? []
            if(!pluginPaths.includes(data.path)){
                pluginPaths.push(data.path)
                workspace.pluginPaths = pluginPaths
                await workspace.save()
            }

            return {
                type: "plugin-paths-updated",
                payload: { workspaceId: data.workspaceId, pluginPaths }
            }
        }

        if(msg.type === "remove-plugin"){
            const {success,data} = RemovePluginSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect plugin schema")
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            const pluginPaths = (workspace.pluginPaths ?? []).filter(p => p !== data.path)
            workspace.pluginPaths = pluginPaths
            await workspace.save()

            return {
                type: "plugin-paths-updated",
                payload: { workspaceId: data.workspaceId, pluginPaths }
            }
        }

        if(msg.type === "update-tools"){
            const {success,data} = UpdateToolsSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect tools schema")
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            workspace.enabledTools = data.enabledTools
            await workspace.save()

            return {
                type: "tools-updated",
                payload: { workspaceId: data.workspaceId, enabledTools: data.enabledTools }
            }
        }

        if(msg.type === "update-sandbox"){
            const {success,data} = UpdateSandboxSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect sandbox schema")
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            workspace.sandboxed = data.sandboxed
            await workspace.save()

            return {
                type: "sandbox-updated",
                payload: { workspaceId: data.workspaceId, sandboxed: data.sandboxed }
            }
        }

        if(msg.type === "add-directory"){
            const {success,data} = AddDirectorySchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect directory schema")
            }

            if(!isAbsolute(data.path) || !existsSync(data.path) || !statSync(data.path).isDirectory()){
                throw new Error(`Additional directory must be an absolute path to an existing directory: ${data.path}`)
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            const additionalDirectories = workspace.additionalDirectories ?? []
            if(!additionalDirectories.includes(data.path)){
                additionalDirectories.push(data.path)
                workspace.additionalDirectories = additionalDirectories
                await workspace.save()
            }

            return {
                type: "directories-updated",
                payload: { workspaceId: data.workspaceId, additionalDirectories }
            }
        }

        if(msg.type === "remove-directory"){
            const {success,data} = RemoveDirectorySchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect directory schema")
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            const additionalDirectories = (workspace.additionalDirectories ?? []).filter(p => p !== data.path)
            workspace.additionalDirectories = additionalDirectories
            await workspace.save()

            return {
                type: "directories-updated",
                payload: { workspaceId: data.workspaceId, additionalDirectories }
            }
        }

        if(msg.type === "add-mcp-server"){
            const {success,data} = AddMcpServerSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect MCP server schema")
            }
            if(data.server.type === "stdio" && !data.server.command){
                throw new Error("A stdio MCP server needs a command")
            }
            if(data.server.type !== "stdio" && !data.server.url){
                throw new Error(`A ${data.server.type} MCP server needs a url`)
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            const mcpServers = ((workspace.mcpServers as unknown as McpServerConfigType[]) ?? []).filter(s => s.name !== data.server.name)
            mcpServers.push(data.server)
            workspace.mcpServers = mcpServers as any
            await workspace.save()

            return {
                type: "mcp-servers-updated",
                payload: { workspaceId: data.workspaceId, mcpServers: mcpServers as McpServerConfigType[] }
            }
        }

        if(msg.type === "remove-mcp-server"){
            const {success,data} = RemoveMcpServerSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect MCP server schema")
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace){
                throw new Error("Workspace not found")
            }

            const mcpServers = ((workspace.mcpServers as unknown as McpServerConfigType[]) ?? []).filter(s => s.name !== data.name)
            workspace.mcpServers = mcpServers as any
            await workspace.save()

            return {
                type: "mcp-servers-updated",
                payload: { workspaceId: data.workspaceId, mcpServers: mcpServers as McpServerConfigType[] }
            }
        }

        if(msg.type === "list-files"){
            const {success,data} = ListFilesSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect list-files schema")
            }

            const workspace = await WorkspaceModel.findById(data.workspaceId)
            if(!workspace || !workspace.path){
                throw new Error("Workspace not found")
            }

            const subpath = data.subpath ?? "";
            const dir = join(workspace.path, subpath);
            // stay inside the workspace: resolve, then confirm it didn't escape via ../
            if(relative(workspace.path, dir).startsWith("..")){
                throw new Error("Path escapes the workspace")
            }
            if(!existsSync(dir) || !statSync(dir).isDirectory()){
                throw new Error(`Not a directory: ${dir}`)
            }

            const entries = readdirSync(dir, { withFileTypes: true })
                .filter(e => !e.name.startsWith("."))
                .map(e => ({ name: e.name, type: (e.isDirectory() ? "dir" : "file") as "dir" | "file" }))
                .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))

            return {
                type: "files-listed",
                payload: { workspaceId: data.workspaceId, subpath, entries }
            }
        }

        if(msg.type === "interrupt"){
            const {success,data} = InterruptSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect interrupt schema")
            }

            const runtime = this.sessionRuntimes.get(data.sessionId);
            if(runtime){
                await runtime.query.interrupt();
            }
            const queue = this.turnQueues.get(data.sessionId);
            const turn = queue?.shift();
            if(turn){
                // the interrupted turn's real "result" is still coming down the
                // SDK's output stream — tell the result handler to discard it
                // instead of misattributing it to whatever turn runs next
                this.staleResultsExpected.set(data.sessionId, (this.staleResultsExpected.get(data.sessionId) ?? 0) + 1);
                turn.resolve({ type: "message-added", payload: { id: data.sessionId } });
            }

            return undefined
        }

        if(msg.type === "permission-response"){
            const {success,data} = PermissionResponseSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect permission-response schema")
            }

            const resolve = this.pendingPermissions.get(data.requestId);
            if(resolve){
                this.pendingPermissions.delete(data.requestId);
                resolve(data.allow
                    ? { behavior: "allow" }
                    : { behavior: "deny", message: "Denied by user" });
            }

            return undefined
        }

        if(msg.type === "rewind-files"){
            const {success,data} = RewindFilesSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect rewind-files schema")
            }

            const runtime = this.sessionRuntimes.get(data.sessionId);
            if(!runtime || !runtime.lastUserMessageUuid){
                return {
                    type: "rewind-result",
                    payload: { sessionId: data.sessionId, canRewind: false, error: "Nothing to rewind yet — send a message first", dryRun: data.dryRun ?? false }
                }
            }

            const result = await runtime.query.rewindFiles(runtime.lastUserMessageUuid, { dryRun: data.dryRun });
            return {
                type: "rewind-result",
                payload: {
                    sessionId: data.sessionId, canRewind: result.canRewind, error: result.error,
                    filesChanged: result.filesChanged, insertions: result.insertions, deletions: result.deletions,
                    dryRun: data.dryRun ?? false
                }
            }
        }

        if(msg.type === "get-mcp-status"){
            const {success,data} = GetMcpStatusSchema.safeParse(msg.payload);
            if(!success){
                throw new Error("Incorrect get-mcp-status schema")
            }

            const runtime = this.sessionRuntimes.get(data.sessionId);
            if(!runtime){
                return { type: "mcp-status", payload: { sessionId: data.sessionId, servers: [] } }
            }

            const statuses = await runtime.query.mcpServerStatus();
            return {
                type: "mcp-status",
                payload: {
                    sessionId: data.sessionId,
                    servers: statuses.map(s => ({ name: s.name, status: s.status, error: s.error, toolCount: s.tools?.length }))
                }
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

            const attachmentMeta = data.attachments?.map(a => ({ name: a.name, mediaType: a.mediaType }));
            const result = await SessionModel.updateOne({ _id: data.sessionId},{$push:{conversation:{role:"user",payload:{message:data.message, attachments: attachmentMeta}}}})
            if(result.matchedCount === 0){
                throw new Error("Session not found")
            }

            let title: string | undefined;
            if(!session.title && session.conversation.length === 0){
                title = deriveSessionTitle(data.message)
                session.title = title
            }

            // model/permissionMode/maxTurns/maxBudgetUsd: an explicit choice on this
            // message becomes the session's sticky default going forward, same as
            // Claude Code's /model
            const model = data.model ?? session.preferredModel ?? undefined;
            const permissionMode = (data.permissionMode ?? session.permissionMode ?? "acceptEdits") as PermissionMode;
            const maxTurns = data.maxTurns ?? session.maxTurns ?? undefined;
            const maxBudgetUsd = data.maxBudgetUsd ?? session.maxBudgetUsd ?? undefined;
            if (data.model && data.model !== session.preferredModel) session.preferredModel = data.model;
            if (data.permissionMode && data.permissionMode !== session.permissionMode) session.permissionMode = data.permissionMode;
            if (data.maxTurns && data.maxTurns !== session.maxTurns) session.maxTurns = data.maxTurns;
            if (data.maxBudgetUsd && data.maxBudgetUsd !== session.maxBudgetUsd) session.maxBudgetUsd = data.maxBudgetUsd;
            await session.save()

            const enabledTools = workspace?.enabledTools?.length ? workspace.enabledTools : DEFAULT_ENABLED_TOOLS;
            const fingerprint = configFingerprint({
                enabledTools, pluginPaths: workspace?.pluginPaths, mcpServers: workspace?.mcpServers,
                sandboxed: workspace?.sandboxed ?? undefined, additionalDirectories: workspace?.additionalDirectories,
                maxTurns, maxBudgetUsd
            });

            let runtime = this.sessionRuntimes.get(data.sessionId);
            if (runtime && runtime.fingerprint !== fingerprint) {
                // tools/plugins/mcp servers changed — no live control request updates
                // those, so the subprocess has to be recreated (still `resume`s the
                // same conversation, just picks up the new config on reconnect)
                runtime.query.close();
                this.sessionRuntimes.delete(data.sessionId);
                runtime = undefined;
            }

            const turnPromise = new Promise<OutgoingMessageType>((resolve, reject) => {
                const queue = this.turnQueues.get(data.sessionId) ?? [];
                queue.push({
                    resolve, reject, session, title, model, permissionMode, maxTurns, maxBudgetUsd,
                    toolCalls: [], toolCallsById: new Map(), thinkingText: ""
                });
                this.turnQueues.set(data.sessionId, queue);
            });

            if (!runtime) {
                const liveState = { permissionMode };
                const { stream, push } = createPushableStream();
                const queryObj = query({
                    prompt: stream,
                    options: {
                        cwd : workspace?.path || process.cwd(),
                        allowedTools: [], // canUseTool below decides everything, dynamically, per live permission mode
                        tools: enabledTools,
                        resume: session.anthropicSessionId ? session.anthropicSessionId : undefined,
                        model,
                        permissionMode,
                        maxTurns,
                        maxBudgetUsd,
                        includePartialMessages: true,
                        // without an explicit display mode, the API only streams redacted
                        // "thinking" pings (token-count deltas, no visible text) — summarized
                        // gets us real thinking text to show in the UI
                        thinking: { type: "adaptive", display: "summarized" },
                        // backs up files before edits so rewind-files can restore them
                        enableFileCheckpointing: true,
                        // user-added local plugin dirs for this workspace, on top of whatever
                        // the CLI already loads from the user's own global/project config
                        plugins: workspace?.pluginPaths?.map(path => ({ type: "local" as const, path })),
                        mcpServers: buildMcpServers(workspace?.mcpServers as McpServerConfigType[] | undefined),
                        additionalDirectories: workspace?.additionalDirectories,
                        // failIfUnavailable:false degrades gracefully to unsandboxed instead
                        // of hard-erroring the whole query when e.g. bubblewrap is missing
                        sandbox: workspace?.sandboxed
                            ? { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false }
                            : undefined,
                        canUseTool: async (toolName, input, opts) => {
                            if (liveState.permissionMode !== "default") return { behavior: "allow" };
                            const requestId = crypto.randomUUID();
                            this.sendMessage({
                                type: "permission-request",
                                payload: { sessionId: data.sessionId, requestId, toolName, input, title: opts.title }
                            })
                            return new Promise<PermissionResult>(resolve => {
                                this.pendingPermissions.set(requestId, resolve);
                            });
                        }
                    }
                });

                runtime = { query: queryObj, push, fingerprint, model, liveState };
                this.sessionRuntimes.set(data.sessionId, runtime);
                this.consumeSession(data.sessionId, queryObj); // persistent background loop, outlives this call
                runtime.lastUserMessageUuid = runtime.push(msg.payload.message, data.attachments);
            } else {
                if (runtime.liveState.permissionMode !== permissionMode) {
                    await runtime.query.setPermissionMode(permissionMode);
                    runtime.liveState.permissionMode = permissionMode;
                }
                if (model !== runtime.model) {
                    await runtime.query.setModel(model);
                    runtime.model = model;
                }
                runtime.lastUserMessageUuid = runtime.push(msg.payload.message, data.attachments);
            }

            return await turnPromise;
        }

        throw new Error("Unhandled message type")
    }
}
