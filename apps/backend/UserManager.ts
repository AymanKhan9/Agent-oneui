import { WebSocket } from "ws";
import { User } from "./User";
import { WorkspaceModel, SessionModel } from "db/client";
import type { McpServerConfig, Session, Workspace } from "commons/types";




export class UserManager{
    private users : User[]
    private static instance : UserManager
    constructor(){
        this.users = []
    }

     static getInstance(): UserManager{
        if(!UserManager.instance){
            UserManager.instance = new UserManager();
        }
        return UserManager.instance
    }

    async addUser(ws:WebSocket){
        const id = crypto.randomUUID()
        const user = new User(id,ws)

        this.users.push(user)

        const workspaces = await WorkspaceModel.find()
        const  sessions = await SessionModel.find()

        const responses: Workspace[]= []

        workspaces.forEach(w=>{
            const finalSessions: Session[] = [];
            sessions.forEach(s=>{
                if(s.workspace[0]?.equals(w._id)){
                    finalSessions.push({
                        id:s._id.toString(),
                        title: s.title ?? undefined,
                        model: s.preferredModel ?? undefined,
                        permissionMode: s.permissionMode ?? undefined,
                        slashCommands: s.slashCommands ?? undefined,
                        loadedPlugins: (s.loadedPlugins as unknown as Session["loadedPlugins"]) ?? undefined,
                        totalCostUsd: s.totalCostUsd ?? undefined,
                        totalInputTokens: s.totalInputTokens ?? undefined,
                        totalOutputTokens: s.totalOutputTokens ?? undefined,
                        maxTurns: s.maxTurns ?? undefined,
                        maxBudgetUsd: s.maxBudgetUsd ?? undefined,
                        messages: s.conversation as unknown as Session["messages"]
                    })
                }
            })
             responses.push({
                id:w._id.toString(),
                name: w.name!,
                path: w.path!,
                pluginPaths: w.pluginPaths ?? undefined,
                enabledTools: w.enabledTools ?? undefined,
                mcpServers: (w.mcpServers as unknown as McpServerConfig[]) ?? undefined,
                sandboxed: w.sandboxed ?? undefined,
                additionalDirectories: w.additionalDirectories ?? undefined,
                sessions:finalSessions
            })
        })

        ws.send(JSON.stringify({
            type:"init",
            workspaces: responses

        }))

        ws.on('message',async (msg)=>{
        try{
             const parsedMessage = JSON.parse(msg.toString())
             const responsePayload = await user.handleIncomingMessage(parsedMessage)
             if(responsePayload) user.sendMessage(responsePayload)

        }catch(e){
            console.error("Failed to handle incoming message:", e);
            user.sendMessage({
                type: "error",
                payload: { message: e instanceof Error ? e.message : "Unknown error" }
            })
        }
    })

    ws.on("close",()=>{
        user.closeAllSessions();
        this.users = this.users.filter(x => x.id!=id)
    })
    };

}
