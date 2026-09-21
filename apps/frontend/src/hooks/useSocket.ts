import { useEffect, useRef, useState } from "react"
import type { IncomingMessageType, OutgoingMessageType } from "commons/types"

export function useSocket(onMessage: (msg: OutgoingMessageType) => void) {
    const [ws] = useState(() => new WebSocket("ws://localhost:8081"))
    const [connected, setConnected] = useState(false)
    const onMessageRef = useRef(onMessage)
    onMessageRef.current = onMessage

    useEffect(() => {
        const onOpen = () => setConnected(true)
        const onClose = () => setConnected(false)
        const onRawMessage = (e: MessageEvent) => onMessageRef.current(JSON.parse(e.data))

        ws.addEventListener("open", onOpen)
        ws.addEventListener("close", onClose)
        ws.addEventListener("message", onRawMessage)
        return () => {
            ws.removeEventListener("open", onOpen)
            ws.removeEventListener("close", onClose)
            ws.removeEventListener("message", onRawMessage)
        }
        // ponytail: single app-lifetime socket, not closed on unmount
    }, [ws])

    const send = (msg: IncomingMessageType) => ws.send(JSON.stringify(msg))

    return { connected, send }
}
