import mongoose from "mongoose";

// a bare `{ type: String, ... }` object literal is ambiguous with Mongoose's
// own `{ type: X }` field-type shorthand, so a nested field literally named
// "type" needs a real sub-schema — otherwise Mongoose silently collapses the
// whole object down to "this field's type is String" and drops every sibling key
const McpServerSchema = new mongoose.Schema(
    { name: String, type: String, url: String, command: String, args: [String] },
    { _id: false }
)

export const Workspace = new mongoose.Schema({
    path:String,
    name:String,
    pluginPaths: [String],
    enabledTools: [String],
    mcpServers: [McpServerSchema],
    sandboxed: Boolean,
    additionalDirectories: [String]

})


export const Session = new mongoose.Schema({
    role: {
        type: String,
        enum: ['user','assistant']
    },
    title: String,
    preferredModel: String,
    permissionMode: String,
    slashCommands: [String],
    loadedPlugins: [{ name: String, path: String, version: String }],
    totalCostUsd: Number,
    totalInputTokens: Number,
    totalOutputTokens: Number,
    maxTurns: Number,
    maxBudgetUsd: Number,
    conversation: [Object],
    workspace : [{type: mongoose.Schema.Types.ObjectId, ref:"Workspace"}],
    anthropicSessionId: String
})


export const WorkspaceModel = mongoose.model("Workspace",Workspace);
export const SessionModel = mongoose.model("Session",Session);