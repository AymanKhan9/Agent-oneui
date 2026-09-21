import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ModelOptions, PermissionModeOptions, ToolOptions,
  type AttachmentMeta, type FileEntry, type McpServerConfig, type McpStatusEntry, type OutgoingMessageType, type Session, type ToolCall, type Workspace
} from "commons/types";
import { useSocket } from "./hooks/useSocket";
import "./index.css";

type PendingAttachment = { name: string; mediaType: string; dataBase64: string };

type PermissionRequest = { requestId: string; toolName: string; input: unknown; title?: string };
type RewindResult = { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number };

const MODEL_LABELS: Record<(typeof ModelOptions)[number], string> = {
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-fable-5": "Fable 5",
};

const PERMISSION_MODE_LABELS: Record<(typeof PermissionModeOptions)[number], string> = {
  acceptEdits: "Edit automatically",
  plan: "Plan",
  auto: "Auto",
  default: "Ask every time",
};

// App-level commands this UI handles itself, intercepted before ever reaching
// the agent — distinct from the agent's own discovered slash commands
const LOCAL_COMMANDS = ["plugin"];

// mirrors the backend's own default (User.ts) so checkboxes show the right
// state before a workspace has ever set its own enabledTools list
const DEFAULT_ENABLED_TOOLS = ["Read", "Edit", "Write", "Glob", "Bash"];

const MCP_STATUS_COLOR: Record<McpStatusEntry["status"], string> = {
  connected: "bg-green-500",
  pending: "bg-yellow-500",
  "needs-auth": "bg-yellow-500",
  failed: "bg-red-500",
  disabled: "bg-muted-foreground/40",
};

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("theme");
    return stored ? stored === "dark" : true; // dark by default
  });
  const [error, setError] = useState<string | null>(null);

  // ponytail: single request in flight per kind, correlated by pending refs
  // instead of per-message request ids (fine for a single-tab local tool)
  const pendingWorkspacePath = useRef<string | null>(null);
  const pendingSessionWorkspaceId = useRef<string | null>(null);
  const pendingAssistantSessionId = useRef<string | null>(null);
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(new Set());
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [streamingThinking, setStreamingThinking] = useState<Record<string, string>>({});
  const [toolProgress, setToolProgress] = useState<Record<string, ToolCall[]>>({});
  // nonce forces the sidebar to re-open the add-plugin input even when /plugin
  // is invoked twice for the same, already-expanded workspace
  const [pluginManagerRequest, setPluginManagerRequest] = useState<{ workspaceId: string; nonce: number } | null>(null);
  const [fileTree, setFileTree] = useState<Record<string, FileEntry[]>>({}); // key: `${workspaceId}:${subpath}`
  const [permissionRequests, setPermissionRequests] = useState<Record<string, PermissionRequest>>({}); // key: sessionId
  const [rewindResult, setRewindResult] = useState<Record<string, RewindResult>>({}); // key: sessionId
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatusEntry[]>>({}); // key: sessionId

  function clearPendingState(sessionId: string) {
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
    setStreamingThinking((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setToolProgress((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setPermissionRequests((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

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
    if (msg.type === "message-added") {
      const { id: sessionId, title, model, permissionMode, slashCommands, totalCostUsd, totalInputTokens, totalOutputTokens, contextUsage } = msg.payload;
      if (!title && !model && !permissionMode && !slashCommands && totalCostUsd === undefined) return;
      setWorkspaces((prev) =>
        prev.map((w) => ({
          ...w,
          sessions: w.sessions.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  ...(title ? { title } : {}),
                  ...(model ? { model } : {}),
                  ...(permissionMode ? { permissionMode } : {}),
                  ...(slashCommands ? { slashCommands } : {}),
                  ...(totalCostUsd !== undefined ? { totalCostUsd, totalInputTokens, totalOutputTokens } : {}),
                  ...(contextUsage ? { contextUsage } : {}),
                }
              : s
          ),
        }))
      );
      return;
    }
    if (msg.type === "assistant-message-delta") {
      const { sessionId, text } = msg.payload;
      setStreamingText((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? "") + text }));
      return;
    }
    if (msg.type === "assistant-thinking-delta") {
      const { sessionId, text } = msg.payload;
      setStreamingThinking((prev) => ({ ...prev, [sessionId]: (prev[sessionId] ?? "") + text }));
      return;
    }
    if (msg.type === "assistant-tool-progress") {
      const { sessionId, toolCalls } = msg.payload;
      setToolProgress((prev) => ({ ...prev, [sessionId]: toolCalls }));
      return;
    }
    if (msg.type === "assistant-message") {
      const sessionId = pendingAssistantSessionId.current;
      pendingAssistantSessionId.current = null;
      if (!sessionId) return;
      clearPendingState(sessionId);
      const text =
        typeof msg.payload?.message === "string" ? msg.payload.message : JSON.stringify(msg.payload);
      const toolCalls = Array.isArray(msg.payload?.toolCalls) ? msg.payload.toolCalls : undefined;
      const thinking = typeof msg.payload?.thinking === "string" ? msg.payload.thinking : undefined;
      setWorkspaces((prev) =>
        prev.map((w) => ({
          ...w,
          sessions: w.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, { role: "assistant" as const, payload: { message: text, toolCalls, thinking } }] }
              : s
          ),
        }))
      );
      return;
    }
    if (msg.type === "compaction") {
      const { sessionId, preTokens, postTokens } = msg.payload;
      const text = `Context compacted — ${preTokens.toLocaleString()} → ${postTokens?.toLocaleString() ?? "?"} tokens`;
      setWorkspaces((prev) =>
        prev.map((w) => ({
          ...w,
          sessions: w.sessions.map((s) =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, { role: "system" as const, payload: { text } }] }
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
      if (sessionId) clearPendingState(sessionId);
      return;
    }
    if (msg.type === "plugin-paths-updated") {
      const { workspaceId, pluginPaths } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, pluginPaths } : w)));
      return;
    }
    if (msg.type === "tools-updated") {
      const { workspaceId, enabledTools } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, enabledTools } : w)));
      return;
    }
    if (msg.type === "mcp-servers-updated") {
      const { workspaceId, mcpServers } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, mcpServers } : w)));
      return;
    }
    if (msg.type === "sandbox-updated") {
      const { workspaceId, sandboxed } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, sandboxed } : w)));
      return;
    }
    if (msg.type === "directories-updated") {
      const { workspaceId, additionalDirectories } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, additionalDirectories } : w)));
      return;
    }
    if (msg.type === "files-listed") {
      const { workspaceId, subpath, entries } = msg.payload;
      setFileTree((prev) => ({ ...prev, [`${workspaceId}:${subpath}`]: entries }));
      return;
    }
    if (msg.type === "permission-request") {
      const { sessionId, requestId, toolName, input, title } = msg.payload;
      setPermissionRequests((prev) => ({ ...prev, [sessionId]: { requestId, toolName, input, title } }));
      return;
    }
    if (msg.type === "rewind-result") {
      const { sessionId, canRewind, error, filesChanged, insertions, deletions } = msg.payload;
      setRewindResult((prev) => ({ ...prev, [sessionId]: { canRewind, error, filesChanged, insertions, deletions } }));
      return;
    }
    if (msg.type === "mcp-status") {
      const { sessionId, servers } = msg.payload;
      setMcpStatus((prev) => ({ ...prev, [sessionId]: servers }));
      return;
    }
    // "message-added" without a title: content is already shown optimistically, ack needs no action
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

  function addPlugin(workspaceId: string, path: string) {
    send({ type: "add-plugin", payload: { workspaceId, path } });
  }

  function removePlugin(workspaceId: string, path: string) {
    send({ type: "remove-plugin", payload: { workspaceId, path } });
  }

  function openPluginManager(sessionId: string) {
    const workspace = workspaces.find((w) => w.sessions.some((s) => s.id === sessionId));
    if (!workspace) return;
    setExpandedWorkspaceId(workspace.id);
    setPluginManagerRequest({ workspaceId: workspace.id, nonce: Date.now() });
  }

  function updateTools(workspaceId: string, enabledTools: (typeof ToolOptions)[number][]) {
    send({ type: "update-tools", payload: { workspaceId, enabledTools } });
  }

  function updateSandbox(workspaceId: string, sandboxed: boolean) {
    send({ type: "update-sandbox", payload: { workspaceId, sandboxed } });
  }

  function addDirectory(workspaceId: string, path: string) {
    send({ type: "add-directory", payload: { workspaceId, path } });
  }

  function removeDirectory(workspaceId: string, path: string) {
    send({ type: "remove-directory", payload: { workspaceId, path } });
  }

  function addMcpServer(workspaceId: string, server: McpServerConfig) {
    send({ type: "add-mcp-server", payload: { workspaceId, server } });
  }

  function removeMcpServer(workspaceId: string, name: string) {
    send({ type: "remove-mcp-server", payload: { workspaceId, name } });
  }

  function listFiles(workspaceId: string, subpath?: string) {
    send({ type: "list-files", payload: { workspaceId, subpath } });
  }

  function interrupt(sessionId: string) {
    send({ type: "interrupt", payload: { sessionId } });
    clearPendingState(sessionId);
  }

  function rewindFiles(sessionId: string) {
    send({ type: "rewind-files", payload: { sessionId } });
  }

  function getMcpStatus(sessionId: string) {
    send({ type: "get-mcp-status", payload: { sessionId } });
  }

  function respondToPermission(sessionId: string, requestId: string, allow: boolean) {
    send({ type: "permission-response", payload: { requestId, allow } });
    setPermissionRequests((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  function sendChatMessage(
    sessionId: string,
    message: string,
    opts: {
      model?: (typeof ModelOptions)[number];
      permissionMode?: (typeof PermissionModeOptions)[number];
      attachments?: PendingAttachment[];
    }
  ) {
    const attachmentMeta: AttachmentMeta[] | undefined = opts.attachments?.map((a) => ({
      name: a.name,
      mediaType: a.mediaType,
    }));
    setWorkspaces((prev) =>
      prev.map((w) => ({
        ...w,
        sessions: w.sessions.map((s) =>
          s.id === sessionId
            ? { ...s, messages: [...s.messages, { role: "user" as const, payload: { message, attachments: attachmentMeta } }] }
            : s
        ),
      }))
    );
    pendingAssistantSessionId.current = sessionId;
    setPendingSessionIds((prev) => new Set(prev).add(sessionId));
    send({
      type: "add-message",
      payload: {
        sessionId,
        message,
        model: opts.model,
        permissionMode: opts.permissionMode,
        attachments: opts.attachments,
      },
    });
  }

  const activeSession = workspaces
    .flatMap((w) => w.sessions)
    .find((s) => s.id === activeSessionId) ?? null;

  if (!connected) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background font-mono text-sm text-muted-foreground">
        connecting...
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {error && (
        <div className="flex shrink-0 items-center justify-between border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 px-2 text-xs opacity-70 hover:opacity-100">
            dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar
          workspaces={workspaces}
          expandedWorkspaceId={expandedWorkspaceId}
          activeSessionId={activeSessionId}
          onToggleWorkspace={(id) => setExpandedWorkspaceId((prev) => (prev === id ? null : id))}
          onCreateWorkspace={createWorkspace}
          onCreateSession={createSession}
          onSelectSession={setActiveSessionId}
          onAddPlugin={addPlugin}
          onRemovePlugin={removePlugin}
          pluginManagerRequest={pluginManagerRequest}
          onUpdateTools={updateTools}
          onAddMcpServer={addMcpServer}
          onRemoveMcpServer={removeMcpServer}
          onListFiles={listFiles}
          fileTree={fileTree}
          onGetMcpStatus={getMcpStatus}
          mcpStatus={activeSessionId ? mcpStatus[activeSessionId] : undefined}
          onUpdateSandbox={updateSandbox}
          onAddDirectory={addDirectory}
          onRemoveDirectory={removeDirectory}
          dark={dark}
          onToggleDark={() => setDark((d) => !d)}
        />
        <ChatWindow
          session={activeSession}
          onSend={sendChatMessage}
          pending={activeSession ? pendingSessionIds.has(activeSession.id) : false}
          streamingText={activeSession ? streamingText[activeSession.id] : undefined}
          streamingThinking={activeSession ? streamingThinking[activeSession.id] : undefined}
          toolProgress={activeSession ? toolProgress[activeSession.id] : undefined}
          onOpenPluginManager={openPluginManager}
          onInterrupt={interrupt}
          permissionRequest={activeSession ? permissionRequests[activeSession.id] : undefined}
          onRespondToPermission={respondToPermission}
          onRewindFiles={rewindFiles}
          rewindResult={activeSession ? rewindResult[activeSession.id] : undefined}
        />
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="shrink-0 fill-none stroke-current stroke-[1.5]">
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

function LightningIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" className="shrink-0 fill-current">
      <path d="M8.5 1L3 9h4l-.5 6L13 7H9l-.5-6z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" className="shrink-0 fill-none stroke-current stroke-[2]">
      <path d="M8 13V3M4 7l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" className="shrink-0 fill-current">
      <rect x="2" y="2" width="12" height="12" rx="2" />
    </svg>
  );
}

// Native <details>/<summary> popover — no browser-default chrome to fight with
// in dark mode (unlike a plain <select>, which is what made the previous
// model/mode controls unreadable), fully styled by us, closes itself on pick.
function Dropdown({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (ref.current) ref.current.open = false;
  };

  useEffect(() => {
    function onDocumentClick(e: MouseEvent) {
      if (ref.current && ref.current.open && !ref.current.contains(e.target as Node)) {
        ref.current.open = false;
      }
    }
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, []);

  return (
    <details ref={ref} className="relative">
      <summary className="block cursor-pointer list-none [&::-webkit-details-marker]:hidden">{trigger}</summary>
      <div className="absolute bottom-full left-0 z-10 mb-1 min-w-max overflow-hidden rounded-md border border-border bg-popover py-1">
        {children(close)}
      </div>
    </details>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      className={`shrink-0 fill-none stroke-current stroke-[1.5] transition-transform duration-150 ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// "npx -y @scope/server --flag" -> {command: "npx", args: ["-y","@scope/server","--flag"]}
// ponytail: naive whitespace split, no quoted-argument support — fine for the
// common case, add real shell-arg parsing if a command actually needs quoting
function splitCommand(input: string): { command: string; args: string[] } {
  const [command, ...args] = input.trim().split(/\s+/);
  return { command: command ?? "", args };
}

function sessionLabel(s: Session): string {
  return s.title || `session ${s.id.slice(-6)}`;
}

function Sidebar({
  workspaces,
  expandedWorkspaceId,
  activeSessionId,
  onToggleWorkspace,
  onCreateWorkspace,
  onCreateSession,
  onSelectSession,
  onAddPlugin,
  onRemovePlugin,
  pluginManagerRequest,
  onUpdateTools,
  onAddMcpServer,
  onRemoveMcpServer,
  onListFiles,
  fileTree,
  onGetMcpStatus,
  mcpStatus,
  onUpdateSandbox,
  onAddDirectory,
  onRemoveDirectory,
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
  onAddPlugin: (workspaceId: string, path: string) => void;
  onRemovePlugin: (workspaceId: string, path: string) => void;
  pluginManagerRequest: { workspaceId: string; nonce: number } | null;
  onUpdateTools: (workspaceId: string, enabledTools: (typeof ToolOptions)[number][]) => void;
  onAddMcpServer: (workspaceId: string, server: McpServerConfig) => void;
  onRemoveMcpServer: (workspaceId: string, name: string) => void;
  onListFiles: (workspaceId: string, subpath?: string) => void;
  fileTree: Record<string, FileEntry[]>;
  onUpdateSandbox: (workspaceId: string, sandboxed: boolean) => void;
  onAddDirectory: (workspaceId: string, path: string) => void;
  onRemoveDirectory: (workspaceId: string, path: string) => void;
  onGetMcpStatus: (sessionId: string) => void;
  mcpStatus: McpStatusEntry[] | undefined;
  dark: boolean;
  onToggleDark: () => void;
}) {
  const [newPath, setNewPath] = useState("");
  const [addingPluginFor, setAddingPluginFor] = useState<string | null>(null);
  const [addingDirectoryFor, setAddingDirectoryFor] = useState<string | null>(null);
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [pluginPathDraft, setPluginPathDraft] = useState("");
  const [addingMcpFor, setAddingMcpFor] = useState<string | null>(null);
  const [mcpDraft, setMcpDraft] = useState<{ name: string; type: McpServerConfig["type"]; target: string }>({
    name: "",
    type: "http",
    target: "",
  });
  const [filesSubpath, setFilesSubpath] = useState<Record<string, string>>({});

  useEffect(() => {
    if (pluginManagerRequest) setAddingPluginFor(pluginManagerRequest.workspaceId);
  }, [pluginManagerRequest]);

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="inline-block h-2 w-2 rounded-full bg-primary" aria-hidden />
          agent-oneui
        </span>
        <button
          onClick={onToggleDark}
          className="rounded-md px-1.5 py-1 font-mono text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {dark ? "light" : "dark"}
        </button>
      </div>

      <form
        className="flex gap-1.5 border-b border-sidebar-border p-2"
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
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <button
          type="submit"
          className="shrink-0 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Add
        </button>
      </form>

      <div className="flex-1 overflow-y-auto py-1">
        {workspaces.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No workspaces yet — add a project path above.</p>
        )}
        {workspaces.map((w) => {
          const open = expandedWorkspaceId === w.id;
          return (
            <div key={w.id}>
              <button
                onClick={() => onToggleWorkspace(w.id)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <Chevron open={open} />
                <span className="min-w-0 flex-1 truncate">{w.name}</span>
              </button>

              {open && (
                <div className="ml-4 border-l border-sidebar-border pl-2">
                  {w.sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onSelectSession(s.id)}
                      title={sessionLabel(s)}
                      className={`block w-full truncate rounded-md px-2 py-1 text-left text-xs ${
                        activeSessionId === s.id
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      }`}
                    >
                      {sessionLabel(s)}
                    </button>
                  ))}
                  <button
                    onClick={() => onCreateSession(w.id)}
                    className="mt-0.5 block w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    + New session
                  </button>

                  <div className="mt-1 border-t border-sidebar-border pt-1">
                    {(w.pluginPaths ?? []).map((p) => (
                      <div key={p} className="flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-sidebar-accent">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={p}>
                          {p}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemovePlugin(w.id, p)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove plugin ${p}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {addingPluginFor === w.id ? (
                      <form
                        className="flex gap-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!pluginPathDraft.trim()) return;
                          onAddPlugin(w.id, pluginPathDraft.trim());
                          setPluginPathDraft("");
                          setAddingPluginFor(null);
                        }}
                      >
                        <input
                          autoFocus
                          value={pluginPathDraft}
                          onChange={(e) => setPluginPathDraft(e.target.value)}
                          onBlur={() => { if (!pluginPathDraft.trim()) setAddingPluginFor(null); }}
                          placeholder="/path/to/plugin"
                          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingPluginFor(w.id)}
                        className="block w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      >
                        + Add plugin
                      </button>
                    )}
                  </div>

                  <div className="mt-1 border-t border-sidebar-border pt-1">
                    <p className="px-2 py-0.5 font-mono text-xs tracking-wide text-muted-foreground uppercase">Tools</p>
                    <div className="flex flex-wrap gap-1 px-2 pb-1">
                      {ToolOptions.map((t) => {
                        const enabledSet = new Set(w.enabledTools?.length ? w.enabledTools : DEFAULT_ENABLED_TOOLS);
                        const on = enabledSet.has(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => {
                              const next = new Set(enabledSet);
                              if (on) next.delete(t);
                              else next.add(t);
                              onUpdateTools(w.id, ToolOptions.filter((o) => next.has(o)));
                            }}
                            className={`rounded-full border px-1.5 py-0.5 font-mono text-xs ${
                              on ? "border-primary text-primary" : "border-border text-muted-foreground"
                            }`}
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => onUpdateSandbox(w.id, !w.sandboxed)}
                      className={`mx-2 mb-1 rounded-full border px-1.5 py-0.5 font-mono text-xs ${
                        w.sandboxed ? "border-primary text-primary" : "border-border text-muted-foreground"
                      }`}
                      title="Run Bash in an OS-level sandbox that restricts filesystem/network access"
                    >
                      Sandboxed Bash
                    </button>
                  </div>

                  <div className="mt-1 border-t border-sidebar-border pt-1">
                    <p className="px-2 py-0.5 font-mono text-xs tracking-wide text-muted-foreground uppercase">Additional directories</p>
                    {(w.additionalDirectories ?? []).map((p) => (
                      <div key={p} className="flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-sidebar-accent">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={p}>
                          {p}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemoveDirectory(w.id, p)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove directory ${p}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {addingDirectoryFor === w.id ? (
                      <form
                        className="flex gap-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!directoryDraft.trim()) return;
                          onAddDirectory(w.id, directoryDraft.trim());
                          setDirectoryDraft("");
                          setAddingDirectoryFor(null);
                        }}
                      >
                        <input
                          autoFocus
                          value={directoryDraft}
                          onChange={(e) => setDirectoryDraft(e.target.value)}
                          onBlur={() => { if (!directoryDraft.trim()) setAddingDirectoryFor(null); }}
                          placeholder="/path/to/directory"
                          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingDirectoryFor(w.id)}
                        className="block w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      >
                        + Add directory
                      </button>
                    )}
                  </div>

                  <div className="mt-1 border-t border-sidebar-border pt-1">
                    <div className="flex items-center justify-between px-2 py-0.5">
                      <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">MCP servers</p>
                      {activeSessionId && w.sessions.some((sess) => sess.id === activeSessionId) && (
                        <button
                          type="button"
                          onClick={() => onGetMcpStatus(activeSessionId)}
                          className="font-mono text-xs text-muted-foreground hover:text-foreground"
                          title="Refresh live connection status"
                        >
                          ↻
                        </button>
                      )}
                    </div>
                    {(w.mcpServers ?? []).map((s) => {
                      const status = mcpStatus?.find((st) => st.name === s.name);
                      return (
                        <div key={s.name} className="flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-sidebar-accent">
                          {status && (
                            <span
                              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${MCP_STATUS_COLOR[status.status]}`}
                              title={status.error ?? status.status}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={s.url ?? s.command}>
                            {s.name} <span className="text-muted-foreground/70">({s.type})</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => onRemoveMcpServer(w.id, s.name)}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label={`Remove MCP server ${s.name}`}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                    {addingMcpFor === w.id ? (
                      <form
                        className="space-y-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!mcpDraft.name.trim() || !mcpDraft.target.trim()) return;
                          const server: McpServerConfig =
                            mcpDraft.type === "stdio"
                              ? { name: mcpDraft.name.trim(), type: "stdio", ...splitCommand(mcpDraft.target.trim()) }
                              : { name: mcpDraft.name.trim(), type: mcpDraft.type, url: mcpDraft.target.trim() };
                          onAddMcpServer(w.id, server);
                          setMcpDraft({ name: "", type: "http", target: "" });
                          setAddingMcpFor(null);
                        }}
                      >
                        <input
                          autoFocus
                          value={mcpDraft.name}
                          onChange={(e) => setMcpDraft((d) => ({ ...d, name: e.target.value }))}
                          placeholder="server name"
                          className="w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <div className="flex gap-1">
                          {(["http", "sse", "stdio"] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setMcpDraft((d) => ({ ...d, type: t }))}
                              className={`rounded-full border px-1.5 py-0.5 font-mono text-xs ${
                                mcpDraft.type === t ? "border-primary text-primary" : "border-border text-muted-foreground"
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                        <input
                          value={mcpDraft.target}
                          onChange={(e) => setMcpDraft((d) => ({ ...d, target: e.target.value }))}
                          onBlur={() => { if (!mcpDraft.name.trim() && !mcpDraft.target.trim()) setAddingMcpFor(null); }}
                          placeholder={mcpDraft.type === "stdio" ? "command, e.g. npx -y @scope/server" : "https://..."}
                          className="w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingMcpFor(w.id)}
                        className="block w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      >
                        + Add MCP server
                      </button>
                    )}
                  </div>

                  <details
                    className="mt-1 border-t border-sidebar-border pt-1"
                    onToggle={(e) => {
                      if (e.currentTarget.open && !fileTree[`${w.id}:${filesSubpath[w.id] ?? ""}`]) onListFiles(w.id, filesSubpath[w.id]);
                    }}
                  >
                    <summary className="cursor-pointer px-2 py-0.5 font-mono text-xs tracking-wide text-muted-foreground uppercase select-none">
                      Files
                    </summary>
                    <div className="px-2 pb-1">
                      {filesSubpath[w.id] && (
                        <button
                          onClick={() => {
                            const parent = filesSubpath[w.id]!.split("/").slice(0, -1).join("/");
                            setFilesSubpath((prev) => ({ ...prev, [w.id]: parent }));
                            onListFiles(w.id, parent);
                          }}
                          className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                        >
                          ..
                        </button>
                      )}
                      {(fileTree[`${w.id}:${filesSubpath[w.id] ?? ""}`] ?? []).map((entry) => (
                        <button
                          key={entry.name}
                          onClick={() => {
                            if (entry.type !== "dir") return;
                            const next = filesSubpath[w.id] ? `${filesSubpath[w.id]}/${entry.name}` : entry.name;
                            setFilesSubpath((prev) => ({ ...prev, [w.id]: next }));
                            onListFiles(w.id, next);
                          }}
                          className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                        >
                          {entry.name}
                          {entry.type === "dir" ? "/" : ""}
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ponytail: label/detail formatting per tool name, generic fallback for anything
// else the agent uses — extend this switch when a new tool needs its own shape
function toolLabel(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | undefined;
  switch (call.name) {
    case "Bash":
      return String(input?.command ?? "");
    case "Read":
      return String(input?.file_path ?? "");
    case "Write":
      return String(input?.file_path ?? "");
    case "Edit":
      return String(input?.file_path ?? "");
    case "Glob":
      return String(input?.pattern ?? "");
    default:
      return "";
  }
}

function ToolCallDetail({ call }: { call: ToolCall }) {
  const input = call.input as Record<string, unknown> | undefined;

  if (call.name === "Edit" && typeof input?.old_string === "string" && typeof input?.new_string === "string") {
    return (
      <div className="space-y-0.5 font-mono text-xs">
        {input.old_string.split("\n").map((line, i) => (
          <div key={`old-${i}`} className="whitespace-pre-wrap break-all bg-destructive/10 text-destructive">
            - {line}
          </div>
        ))}
        {input.new_string.split("\n").map((line, i) => (
          <div key={`new-${i}`} className="whitespace-pre-wrap break-all bg-success/10 text-success">
            + {line}
          </div>
        ))}
      </div>
    );
  }

  if (call.name === "Write" && typeof input?.content === "string") {
    return (
      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
        {input.content}
      </pre>
    );
  }

  return (
    <>
      {call.result !== undefined && (
        <pre
          className={`max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs ${
            call.isError ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {call.result || "(no output)"}
        </pre>
      )}
      {call.result === undefined && input !== undefined && (
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </>
  );
}

function ToolCallLine({ call }: { call: ToolCall }) {
  const label = toolLabel(call);
  const borderColor = call.isError ? "border-l-destructive" : "border-l-border";

  return (
    <details className={`group border-l-2 ${borderColor} pl-2`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 font-mono text-xs text-muted-foreground select-none">
        <span className={call.isError ? "text-destructive" : "text-primary"}>●</span>
        <span className="text-foreground">{call.name}</span>
        {label && <span className="min-w-0 truncate">({label})</span>}
      </summary>
      <div className="mt-0.5 border-l border-border pl-3">
        <ToolCallDetail call={call} />
      </div>
    </details>
  );
}

function AttachmentChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      <PaperclipIcon />
      {name}
    </span>
  );
}

function PaperclipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" className="shrink-0 fill-none stroke-current stroke-[1.5]">
      <path
        d="M10.5 4.5l-5 5a2 2 0 002.83 2.83l5-5a3.5 3.5 0 00-4.95-4.95l-5 5a5 5 0 007.07 7.07"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="mb-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1">
      <summary className="cursor-pointer select-none font-mono text-xs text-muted-foreground">Thinking</summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{text}</p>
    </details>
  );
}

function MessageRow({
  role,
  text,
  toolCalls,
  attachments,
  thinking,
}: {
  role: "user" | "assistant" | "system";
  text: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentMeta[];
  thinking?: string;
}) {
  if (role === "system") {
    return (
      <div className="mb-3 flex justify-center">
        <span className="font-mono text-xs text-muted-foreground">— {text} —</span>
      </div>
    );
  }

  if (role === "user") {
    return (
      <div className="mb-3 flex gap-2">
        <span className="shrink-0 font-mono text-xs text-primary select-none">&gt;</span>
        <div className="min-w-0 flex-1 space-y-1">
          {attachments && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {attachments.map((a, i) => (
                <AttachmentChip key={i} name={a.name} />
              ))}
            </div>
          )}
          {text && <p className="whitespace-pre-wrap break-words text-sm">{text}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 flex gap-2">
      <span className="mt-1 shrink-0 text-primary select-none">●</span>
      <div className="min-w-0 flex-1 space-y-1">
        {thinking && <ThinkingBlock text={thinking} />}
        {toolCalls && toolCalls.length > 0 && (
          <div className="mb-1 space-y-0.5">
            {toolCalls.map((t) => (
              <ToolCallLine key={t.id} call={t} />
            ))}
          </div>
        )}
        {text && <p className="whitespace-pre-wrap break-words text-sm">{text}</p>}
      </div>
    </div>
  );
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ChatWindow({
  session,
  onSend,
  pending,
  streamingText,
  streamingThinking,
  toolProgress,
  onOpenPluginManager,
  onInterrupt,
  permissionRequest,
  onRespondToPermission,
  onRewindFiles,
  rewindResult,
}: {
  session: Session | null;
  onSend: (
    sessionId: string,
    message: string,
    opts: {
      model?: (typeof ModelOptions)[number];
      permissionMode?: (typeof PermissionModeOptions)[number];
      attachments?: PendingAttachment[];
    }
  ) => void;
  pending: boolean;
  streamingText: string | undefined;
  streamingThinking: string | undefined;
  toolProgress: ToolCall[] | undefined;
  onOpenPluginManager: (sessionId: string) => void;
  onInterrupt: (sessionId: string) => void;
  permissionRequest: PermissionRequest | undefined;
  onRespondToPermission: (sessionId: string, requestId: string, allow: boolean) => void;
  onRewindFiles: (sessionId: string) => void;
  rewindResult: RewindResult | undefined;
}) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<(typeof ModelOptions)[number] | "">("");
  const [permissionMode, setPermissionMode] = useState<(typeof PermissionModeOptions)[number]>("acceptEdits");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [session?.id, session?.messages.length, pending, streamingText, streamingThinking]);

  // switching sessions: adopt that session's saved model/mode, drop any staged attachments
  useEffect(() => {
    setModel((session?.model as (typeof ModelOptions)[number] | undefined) ?? "");
    setPermissionMode((session?.permissionMode as (typeof PermissionModeOptions)[number] | undefined) ?? "acceptEdits");
    setAttachments([]);
    setFileError(null);
  }, [session?.id]);

  if (!session) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Select or create a session to start chatting
      </div>
    );
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setFileError(null);
    const next: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      if (attachments.length + next.length >= MAX_ATTACHMENTS) {
        setFileError(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
        break;
      }
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
        setFileError(`${file.name}: only images and PDFs are supported.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setFileError(`${file.name}: over 5MB, skipped.`);
        continue;
      }
      next.push({ name: file.name, mediaType: file.type, dataBase64: await fileToBase64(file) });
    }
    setAttachments((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const slashMatches =
    input.startsWith("/") && !input.includes(" ")
      ? [...LOCAL_COMMANDS, ...(session.slashCommands ?? [])].filter((c) =>
          c.toLowerCase().startsWith(input.slice(1).toLowerCase())
        )
      : [];
  const showSlashMenu = input.startsWith("/") && !input.includes(" ") && slashMatches.length > 0;

  // returns true if `name` was one of ours and handled — never reaches the agent
  function runLocalCommand(name: string): boolean {
    if (name !== "plugin") return false;
    onOpenPluginManager(session!.id);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    return true;
  }

  function submit() {
    const trimmed = input.trim();
    if ((!trimmed && attachments.length === 0) || pending) return;
    if (trimmed.startsWith("/") && runLocalCommand(trimmed.slice(1))) return;

    onSend(session!.id, trimmed, {
      model: model || undefined,
      permissionMode,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{sessionLabel(session)}</span>
        <div className="flex shrink-0 items-center gap-3">
          {session.messages.some((m) => m.role === "assistant") && !pending && (
            <button
              type="button"
              onClick={() => onRewindFiles(session.id)}
              className="font-mono text-xs text-muted-foreground hover:text-foreground"
              title="Restore files to their state before your last message"
            >
              ↺ Undo last turn
            </button>
          )}
          {session.contextUsage !== undefined && (
            <span className="font-mono text-xs text-muted-foreground" title={`${session.contextUsage.totalTokens.toLocaleString()} / ${session.contextUsage.maxTokens.toLocaleString()} tokens`}>
              {Math.round(session.contextUsage.percentage)}% context
            </span>
          )}
          {session.totalCostUsd !== undefined && (
            <span className="font-mono text-xs text-muted-foreground" title={`${session.totalInputTokens ?? 0} in / ${session.totalOutputTokens ?? 0} out tokens`}>
              ${session.totalCostUsd.toFixed(4)}
            </span>
          )}
        </div>
      </div>
      {rewindResult && (
        <div className="shrink-0 border-b border-border px-4 py-1.5 font-mono text-xs text-muted-foreground">
          {rewindResult.canRewind
            ? `Restored ${rewindResult.filesChanged?.length ?? 0} file(s) — +${rewindResult.insertions ?? 0}/-${rewindResult.deletions ?? 0}`
            : `Couldn't undo: ${rewindResult.error ?? "nothing to restore"}`}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {session.messages.map((m, i) =>
          m.role === "user" ? (
            <MessageRow key={i} role="user" text={m.payload.message} attachments={m.payload.attachments} />
          ) : m.role === "assistant" ? (
            <MessageRow key={i} role="assistant" text={m.payload.message} toolCalls={m.payload.toolCalls} thinking={m.payload.thinking} />
          ) : (
            <MessageRow key={i} role="system" text={m.payload.text} />
          )
        )}
        {pending && (
          <div className="mb-3 flex gap-2">
            <span className="mt-1 shrink-0 animate-pulse text-primary select-none">●</span>
            <div className="min-w-0 flex-1 space-y-1">
              {streamingThinking && <ThinkingBlock text={streamingThinking} />}
              {toolProgress && toolProgress.length > 0 && (
                <div className="mb-1 space-y-0.5">
                  {toolProgress.map((t) => (
                    <ToolCallLine key={t.id} call={t} />
                  ))}
                </div>
              )}
              {permissionRequest ? (
                <div className="max-w-md rounded-md border border-primary/40 bg-muted p-2">
                  <p className="text-sm">
                    {permissionRequest.title ?? `Allow ${permissionRequest.toolName}?`}
                  </p>
                  <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                    {JSON.stringify(permissionRequest.input, null, 2)}
                  </pre>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onRespondToPermission(session.id, permissionRequest.requestId, true)}
                      className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      onClick={() => onRespondToPermission(session.id, permissionRequest.requestId, false)}
                      className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ) : streamingText ? (
                <p className="whitespace-pre-wrap break-words text-sm">{streamingText}</p>
              ) : !toolProgress || toolProgress.length === 0 ? (
                <p className="text-sm text-muted-foreground">thinking...</p>
              ) : null}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 p-3">
        {fileError && <p className="mb-1.5 font-mono text-xs text-destructive">{fileError}</p>}
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {attachments.map((a, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
              >
                <PaperclipIcon />
                {a.name}
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="ml-0.5 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <form
          className="relative rounded-2xl border border-border bg-muted/60 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {showSlashMenu && (
            <div className="absolute bottom-full left-0 mb-1 max-h-40 w-64 overflow-y-auto rounded-md border border-border bg-popover py-1">
              {slashMatches.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { if (!runLocalCommand(c)) setInput(`/${c} `); }}
                  className="block w-full px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
                >
                  /{c}
                </button>
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => handleFiles(e.target.files)}
            className="hidden"
          />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Type a message, or / for commands..."
            disabled={pending}
            rows={1}
            className="max-h-40 w-full resize-none bg-transparent px-1 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-50"
          />

          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={pending}
                title="Attach image or PDF"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              >
                <PlusIcon />
              </button>

              <Dropdown
                trigger={
                  <span className="rounded-full border border-border px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                    {model ? MODEL_LABELS[model] : "Default"}
                  </span>
                }
              >
                {(close) => (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setModel("");
                        close();
                      }}
                      className="block w-full px-3 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
                    >
                      Default
                    </button>
                    {ModelOptions.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setModel(m);
                          close();
                        }}
                        className="block w-full px-3 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
                      >
                        {MODEL_LABELS[m]}
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>

              <Dropdown
                trigger={
                  <span className="flex items-center gap-1 rounded-full border border-border px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                    <LightningIcon />
                    {PERMISSION_MODE_LABELS[permissionMode]}
                  </span>
                }
              >
                {(close) => (
                  <>
                    {PermissionModeOptions.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setPermissionMode(m);
                          close();
                        }}
                        className="block w-full px-3 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
                      >
                        {PERMISSION_MODE_LABELS[m]}
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>
            </div>

            {pending ? (
              <button
                type="button"
                onClick={() => onInterrupt(session.id)}
                aria-label="Stop"
                title="Stop"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive text-primary-foreground hover:opacity-90"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachments.length === 0}
                aria-label="Send"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40"
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default App;
