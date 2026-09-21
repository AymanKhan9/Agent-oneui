import { useEffect, useRef, useState } from "react";
import type { OutgoingMessageType, Session, Workspace } from "commons/types";
import { useSocket } from "./hooks/useSocket";
import "./index.css";

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
  const [error, setError] = useState<string | null>(null);

  // ponytail: single request in flight per kind, correlated by pending refs
  // instead of per-message request ids (fine for a single-tab local tool)
  const pendingWorkspacePath = useRef<string | null>(null);
  const pendingSessionWorkspaceId = useRef<string | null>(null);
  const pendingAssistantSessionId = useRef<string | null>(null);
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(new Set());
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});

  const { connected, send } = useSocket((msg: OutgoingMessageType) => {
    if (msg.type === "init") {
      setWorkspaces(msg.workspaces);
      return;
    }
    if (msg.type === "workspace-created") {
      const path = pendingWorkspacePath.current;
      pendingWorkspacePath.current = null;
      if (!path) return;
      const workspace: Workspace = {
        id: msg.payload.id,
        name: path.split("/").pop() || path,
        path,
        sessions: [],
      };
      setWorkspaces((prev) => [...prev, workspace]);
      setExpandedWorkspaceId(workspace.id);
      return;
    }
    if (msg.type === "session-created") {
      const workspaceId = pendingSessionWorkspaceId.current;
      pendingSessionWorkspaceId.current = null;
      if (!workspaceId) return;
      const session: Session = { id: msg.payload.id, messages: [] };
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === workspaceId ? { ...w, sessions: [...w.sessions, session] } : w))
      );
      setActiveSessionId(session.id);
      return;
    }
    if (msg.type === "assistant-message-delta") {
      const { sessionId, text } = msg.payload;
      setStreamingText((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? "") + text }));
      return;
    }
    if (msg.type === "assistant-message") {
      const sessionId = pendingAssistantSessionId.current;
      pendingAssistantSessionId.current = null;
      if (!sessionId) return;
      setPendingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setStreamingText((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      const text =
        typeof msg.payload?.message === "string" ? msg.payload.message : JSON.stringify(msg.payload);
      const toolCalls = Array.isArray(msg.payload?.toolCalls) ? msg.payload.toolCalls : undefined;
      setWorkspaces((prev) =>
        prev.map((w) => ({
          ...w,
          sessions: w.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, { role: "assistant" as const, payload: { message: text, toolCalls } }] }
              : s
          ),
        }))
      );
      return;
    }
    if (msg.type === "error") {
      setError(msg.payload.message);
      pendingWorkspacePath.current = null;
      pendingSessionWorkspaceId.current = null;
      const sessionId = pendingAssistantSessionId.current;
      pendingAssistantSessionId.current = null;
      if (sessionId) {
        setPendingSessionIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        setStreamingText((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
      return;
    }
    // "message-added": content is already shown optimistically, ack needs no action
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  function createWorkspace(path: string) {
    pendingWorkspacePath.current = path;
    send({ type: "create-workspace", payload: { path } });
  }

  function createSession(workspaceId: string) {
    pendingSessionWorkspaceId.current = workspaceId;
    send({ type: "create-session", payload: { workspaceId } });
  }

  function sendChatMessage(sessionId: string, message: string) {
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) =>
          s.id === sessionId
            ? { ...s, messages: [...s.messages, { role: "user" as const, payload: { message } }] }
            : s
        ),
      }))
    );
    pendingAssistantSessionId.current = sessionId;
    setPendingSessionIds((prev) => new Set(prev).add(sessionId));
    send({ type: "add-message", payload: { sessionId, message } });
  }

  const activeSession = workspaces
    .flatMap((w) => w.sessions)
    .find((s) => s.id === activeSessionId) ?? null;

  if (!connected) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        connecting...
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {error && (
        <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="px-2 text-xs opacity-70 hover:opacity-100">
            dismiss
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
      <Sidebar
        workspaces={workspaces}
        expandedWorkspaceId={expandedWorkspaceId}
        activeSessionId={activeSessionId}
        onToggleWorkspace={(id) => setExpandedWorkspaceId((prev) => (prev === id ? null : id))}
        onCreateWorkspace={createWorkspace}
        onCreateSession={createSession}
        onSelectSession={setActiveSessionId}
        dark={dark}
        onToggleDark={() => setDark((d) => !d)}
      />
      <ChatWindow
        session={activeSession}
        onSend={sendChatMessage}
        pending={activeSession ? pendingSessionIds.has(activeSession.id) : false}
        streamingText={activeSession ? streamingText[activeSession.id] : undefined}
      />
      </div>
    </div>
  );
}

function Sidebar({
  workspaces,
  expandedWorkspaceId,
  activeSessionId,
  onToggleWorkspace,
  onCreateWorkspace,
  onCreateSession,
  onSelectSession,
  dark,
  onToggleDark,
}: {
  workspaces: Workspace[];
  expandedWorkspaceId: string | null;
  activeSessionId: string | null;
  onToggleWorkspace: (id: string) => void;
  onCreateWorkspace: (path: string) => void;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (id: string) => void;
  dark: boolean;
  onToggleDark: () => void;
}) {
  const [newPath, setNewPath] = useState("");

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="text-sm font-semibold">Workspaces</span>
        <button
          onClick={onToggleDark}
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          {dark ? "light" : "dark"}
        </button>
      </div>

      <form
        className="flex gap-2 border-b border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newPath.trim()) return;
          onCreateWorkspace(newPath.trim());
          setNewPath("");
        }}
      >
        <input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="/path/to/workspace"
          className="min-w-0 flex-1 rounded border border-input bg-transparent px-2 py-1 text-sm"
        />
        <button type="submit" className="rounded bg-primary px-2 py-1 text-sm text-primary-foreground">
          Add
        </button>
      </form>

      <div className="flex-1 overflow-y-auto">
        {workspaces.map((w) => (
          <div key={w.id} className="border-b border-border">
            <button
              onClick={() => onToggleWorkspace(w.id)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="truncate">{w.name}</span>
              <span className="text-muted-foreground">{expandedWorkspaceId === w.id ? "-" : "+"}</span>
            </button>

            {expandedWorkspaceId === w.id && (
              <div className="pb-2 pl-3">
                {w.sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onSelectSession(s.id)}
                    className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${
                      activeSessionId === s.id
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {s.id}
                  </button>
                ))}
                <button
                  onClick={() => onCreateSession(w.id)}
                  className="mt-1 block w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
                >
                  + New session
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatWindow({
  session,
  onSend,
  pending,
  streamingText,
}: {
  session: Session | null;
  onSend: (sessionId: string, message: string) => void;
  pending: boolean;
  streamingText: string | undefined;
}) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [session?.messages.length, pending, streamingText]);

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a session to start chatting
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        {session.messages.map((m, i) => (
          <div key={i} className={`mb-2 flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
            {m.role === "assistant" && m.payload.toolCalls && m.payload.toolCalls.length > 0 && (
              <details className="mb-1 max-w-[70%] rounded-lg border border-border bg-muted px-2 py-1 text-xs">
                <summary className="cursor-pointer select-none text-muted-foreground">
                  {m.payload.toolCalls.length} tool call{m.payload.toolCalls.length > 1 ? "s" : ""}
                </summary>
                <ul className="mt-1 space-y-1 pl-2 font-mono">
                  {m.payload.toolCalls.map((t, ti) => (
                    <li key={ti}>
                      <span className="text-foreground">{t.name}</span>
                      {t.input !== undefined && (
                        <pre className="mt-0.5 whitespace-pre-wrap break-all text-muted-foreground">
                          {JSON.stringify(t.input, null, 2)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div
              className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
              }`}
            >
              {m.payload.message}
            </div>
          </div>
        ))}
        {pending && (
          <div className="mb-2 flex justify-start">
            <div className="max-w-[70%] rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground">
              {streamingText ? streamingText : <span className="text-muted-foreground">thinking...</span>}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || pending) return;
          onSend(session.id, input.trim());
          setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={pending}
          className="min-w-0 flex-1 rounded border border-input bg-transparent px-3 py-2 text-sm disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

export default App;
