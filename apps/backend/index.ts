import { WebSocketServer } from "ws";
import mongoose from "mongoose";
import { UserManager } from "./UserManager";


mongoose.connect(process.env.DB_URL!).catch((e)=>{
    console.log(e)
})

const server = new WebSocketServer({ port: 8081 });

server.on('connection', function(ws){
    UserManager.getInstance().addUser(ws)
  
})