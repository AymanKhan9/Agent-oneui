import mongoose from "mongoose";

export const Workspace = new mongoose.Schema({
    path:String,
    name:String

})


export const Session = new mongoose.Schema({
    role: {
        type: String,
        enum: ['user','assistant']
    },
    conversation: [Object],
    workspace : [{type: mongoose.Schema.Types.ObjectId, ref:"Workspace"}],
    anthropicSessionId: String 
})


export const WorkspaceModel = mongoose.model("Workspace",Workspace);
export const SessionModel = mongoose.model("Session",Session);