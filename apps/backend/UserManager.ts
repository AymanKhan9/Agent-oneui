import { WebSocket } from "ws";
import { uuid } from "uuidv4";
import { User } from "./User";
import { WorkspaceModel, SessionModel } from "db/client";
import type { Session, Workspace } from "commons/types";




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
        const id = uuid()
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
                        messages: s.conversation as unknown as Session["messages"]
                    })
                }
            })
             responses.push({
                id:w._id.toString(),
                name: w.name!,
                path: w.path!,
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
             user.sendMessage(responsePayload)

        }catch(e){
            console.error("Failed to handle incoming message:", e);
            user.sendMessage({
                type: "error",
                payload: { message: e instanceof Error ? e.message : "Unknown error" }
            })
        }
    })

    ws.on("close",()=>{
        this.users = this.users.filter(x => x.id!=id)
    })
    };

   




}