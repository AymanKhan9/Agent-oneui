import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ModelOptions, PermissionModeOptions, ToolOptions,
  type AgentDefinition, type AttachmentMeta, type ElicitationRequestPayload, type McpServerConfig, type McpStatusEntry, type OutgoingMessageType, type Session, type ToolCall, type UsageInfoPayload, type Workspace
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
const LOCAL_COMMANDS = ["plugin", "usage"];

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
  const [permissionRequests, setPermissionRequests] = useState<Record<string, PermissionRequest>>({}); // key: sessionId
  const [rewindResult, setRewindResult] = useState<Record<string, RewindResult>>({}); // key: sessionId
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatusEntry[]>>({}); // key: sessionId
  const [usageInfo, setUsageInfo] = useState<Record<string, UsageInfoPayload>>({}); // key: sessionId
  const [elicitationRequests, setElicitationRequests] = useState<Record<string, ElicitationRequestPayload>>({}); // key: sessionId

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
    setElicitationRequests((prev) => {
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
    if (msg.type === "usage-info") {
      setUsageInfo((prev) => ({ ...prev, [msg.payload.sessionId]: msg.payload }));
      return;
    }
    if (msg.type === "agents-updated") {
      const { workspaceId, agents } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, agents } : w)));
      return;
    }
    if (msg.type === "fallback-model-updated") {
      const { workspaceId, fallbackModel } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, fallbackModel } : w)));
      return;
    }
    if (msg.type === "system-prompt-updated") {
      const { workspaceId, systemPromptAppend } = msg.payload;
      setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? { ...w, systemPromptAppend } : w)));
      return;
    }
    if (msg.type === "elicitation-request") {
      const { sessionId } = msg.payload;
      setElicitationRequests((prev) => ({ ...prev, [sessionId]: msg.payload }));
      return;
    }
    if (msg.type === "task-notification") {
      const { sessionId, status, summary } = msg.payload;
      const text = `Background task ${status}: ${summary}`;
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

  function getUsage(sessionId: string) {
    send({ type: "get-usage", payload: { sessionId } });
  }

  function respondToPermission(sessionId: string, requestId: string, allow: boolean) {
    send({ type: "permission-response", payload: { requestId, allow } });
    setPermissionRequests((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  function addAgent(workspaceId: string, agent: AgentDefinition) {
    send({ type: "add-agent", payload: { workspaceId, agent } });
  }

  function removeAgent(workspaceId: string, name: string) {
    send({ type: "remove-agent", payload: { workspaceId, name } });
  }

  function updateFallbackModel(workspaceId: string, fallbackModel: string) {
    send({ type: "update-fallback-model", payload: { workspaceId, fallbackModel } });
  }

  function updateSystemPrompt(workspaceId: string, systemPromptAppend: string) {
    send({ type: "update-system-prompt", payload: { workspaceId, systemPromptAppend } });
  }

  function backgroundTask(sessionId: string, toolUseId?: string) {
    send({ type: "background-task", payload: { sessionId, toolUseId } });
  }

  function respondToElicitation(sessionId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, string>) {
    send({ type: "elicitation-response", payload: { requestId, action, content } });
    setElicitationRequests((prev) => {
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
  const activeWorkspace = workspaces.find((w) => w.sessions.some((s) => s.id === activeSessionId)) ?? null;

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
          dark={dark}
          onToggleDark={() => setDark((d) => !d)}
        />
        <ChatWindow
          session={activeSession}
          workspace={activeWorkspace}
          onSend={sendChatMessage}
          pending={activeSession ? pendingSessionIds.has(activeSession.id) : false}
          streamingText={activeSession ? streamingText[activeSession.id] : undefined}
          streamingThinking={activeSession ? streamingThinking[activeSession.id] : undefined}
          toolProgress={activeSession ? toolProgress[activeSession.id] : undefined}
          onInterrupt={interrupt}
          permissionRequest={activeSession ? permissionRequests[activeSession.id] : undefined}
          onRespondToPermission={respondToPermission}
          onRewindFiles={rewindFiles}
          rewindResult={activeSession ? rewindResult[activeSession.id] : undefined}
          onBackgroundTask={backgroundTask}
          elicitationRequest={activeSession ? elicitationRequests[activeSession.id] : undefined}
          onRespondToElicitation={respondToElicitation}
          onAddPlugin={addPlugin}
          onRemovePlugin={removePlugin}
          onUpdateTools={updateTools}
          onUpdateSandbox={updateSandbox}
          onAddDirectory={addDirectory}
          onRemoveDirectory={removeDirectory}
          onAddAgent={addAgent}
          onRemoveAgent={removeAgent}
          onUpdateFallbackModel={updateFallbackModel}
          onUpdateSystemPrompt={updateSystemPrompt}
          onAddMcpServer={addMcpServer}
          onRemoveMcpServer={removeMcpServer}
          onGetMcpStatus={getMcpStatus}
          mcpStatus={activeSessionId ? mcpStatus[activeSessionId] : undefined}
          onGetUsage={getUsage}
          usageInfo={activeSessionId ? usageInfo[activeSessionId] : undefined}
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

// Small ring, fills as context fills — click sends `/compact` the same way
// typing it would. Replaces the "N% context" header text.
function ContextRing({ percentage, onClick }: { percentage: number; onClick: () => void }) {
  const clamped = Math.min(100, Math.max(0, percentage));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const color = clamped >= 80 ? "text-destructive" : clamped >= 50 ? "text-yellow-500" : "text-muted-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${Math.round(clamped)}% context used — click to compact`}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-accent hover:text-accent-foreground ${color}`}
    >
      <svg viewBox="0 0 18 18" width="16" height="16" className="-rotate-90">
        <circle cx="9" cy="9" r={radius} strokeWidth="2" fill="none" className="stroke-border" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          strokeWidth="2"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="stroke-current"
        />
      </svg>
    </button>
  );
}

function formatResetsIn(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "soon";
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.round(ms / 60000)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function UsageBar({
  label,
  utilization,
  resetsAt,
}: {
  label: string;
  utilization: number | null | undefined;
  resetsAt: string | null | undefined;
}) {
  const pct = Math.min(100, Math.max(0, utilization ?? 0));
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-xs text-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{utilization != null ? `${Math.round(utilization)}%` : "—"}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      {resetsAt && <p className="mt-1 font-mono text-xs text-muted-foreground">Resets in {formatResetsIn(resetsAt)}</p>}
    </div>
  );
}

// mirrors Claude Code's own "Account & Usage" dialog — pulled from the SDK's
// experimental usage/account control requests, hence the possible-undefined
// fields (rate-limit windows are absent for API-key sessions, etc.)
function UsageModal({ usage, onClose }: { usage: UsageInfoPayload | undefined; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Account &amp; Usage</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            ×
          </button>
        </div>

        {!usage ? (
          <p className="font-mono text-xs text-muted-foreground">Loading…</p>
        ) : usage.error ? (
          <p className="font-mono text-xs text-muted-foreground">{usage.error}</p>
        ) : (
          <>
            {usage.account && (
              <div className="mb-4">
                <p className="mb-1 font-mono text-xs tracking-wide text-muted-foreground uppercase">Account</p>
                <div className="space-y-0.5 font-mono text-xs">
                  {usage.account.tokenSource && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Auth method</span>
                      <span className="min-w-0 truncate text-foreground">{usage.account.tokenSource}</span>
                    </div>
                  )}
                  {usage.account.email && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Email</span>
                      <span className="min-w-0 truncate text-foreground">{usage.account.email}</span>
                    </div>
                  )}
                  {usage.account.organization && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Organization</span>
                      <span className="min-w-0 truncate text-foreground">{usage.account.organization}</span>
                    </div>
                  )}
                  {usage.account.subscriptionType && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Plan</span>
                      <span className="min-w-0 truncate text-foreground">{usage.account.subscriptionType}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div>
              <p className="mb-1 font-mono text-xs tracking-wide text-muted-foreground uppercase">Usage</p>
              {usage.fiveHour && <UsageBar label="Session (5hr)" utilization={usage.fiveHour.utilization} resetsAt={usage.fiveHour.resetsAt} />}
              {usage.sevenDay && <UsageBar label="Weekly (7 day)" utilization={usage.sevenDay.utilization} resetsAt={usage.sevenDay.resetsAt} />}
              {!usage.fiveHour && !usage.sevenDay && (
                <p className="font-mono text-xs text-muted-foreground">
                  {usage.totalCostUsd !== undefined ? `Session cost: $${usage.totalCostUsd.toFixed(4)}` : "No rate-limit data available for this account."}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
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

// Renders assistant/thinking text as markdown — inline `code`, fenced blocks,
// bold, lists, links, etc. — styled to match the existing theme instead of
// react-markdown's unstyled defaults (which is what left backticks/asterisks
// showing up as literal characters before this existed).
function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`markdown-body ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 whitespace-pre-wrap break-words last:mb-0">{children}</p>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-border pl-2 text-muted-foreground last:mb-0">{children}</blockquote>
          ),
          h1: ({ children }) => <p className="mb-1 font-semibold text-foreground">{children}</p>,
          h2: ({ children }) => <p className="mb-1 font-semibold text-foreground">{children}</p>,
          h3: ({ children }) => <p className="mb-1 font-semibold text-foreground">{children}</p>,
          hr: () => <hr className="my-2 border-border" />,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
            if (!isBlock) {
              return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>;
            }
            return <code className="font-mono text-xs">{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="mb-2 overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-xs last:mb-0">
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="mb-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1">
      <summary className="cursor-pointer select-none font-mono text-xs text-muted-foreground">Thinking</summary>
      <Markdown text={text} className="mt-1 text-xs text-muted-foreground" />
    </details>
  );
}

// mode 'url': the server just needs an ack so its OAuth-style flow can proceed
// in the opened tab. mode 'form' (or unset): one text input per JSON-Schema
// property — a generic-but-correct form, not a full JSON Schema UI generator.
function ElicitationCard({
  request,
  onRespond,
}: {
  request: ElicitationRequestPayload;
  onRespond: (action: "accept" | "decline" | "cancel", content?: Record<string, string>) => void;
}) {
  const properties = (request.requestedSchema?.properties as Record<string, any> | undefined) ?? {};
  const fieldNames = Object.keys(properties);
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="max-w-md rounded-md border border-primary/40 bg-muted p-2">
      <p className="text-sm">{request.title ?? `${request.serverName} needs input`}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{request.message}</p>
      {request.mode === "url" && request.url && (
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Open link ↗
        </a>
      )}
      {request.mode !== "url" &&
        fieldNames.map((key) => (
          <input
            key={key}
            value={values[key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            placeholder={key}
            className="mt-1 w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        ))}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => onRespond("accept", request.mode === "url" ? undefined : values)}
          className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          {request.mode === "url" ? "Continue" : "Submit"}
        </button>
        <button
          type="button"
          onClick={() => onRespond("decline")}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

type ComposerPanel = "menu" | "plugins" | "tools" | "directories" | "agents" | "mcp" | "fallbackModel" | "systemPrompt";

const WORKSPACE_MENU_ITEMS: { key: ComposerPanel; label: string }[] = [
  { key: "plugins", label: "Plugins" },
  { key: "tools", label: "Tools & sandbox" },
  { key: "directories", label: "Additional directories" },
  { key: "agents", label: "Subagents" },
  { key: "mcp", label: "MCP servers" },
  { key: "fallbackModel", label: "Fallback model" },
  { key: "systemPrompt", label: "Instructions" },
];

// The composer's "+" menu — mirrors Claude Code's own attach/settings menu:
// a flat list of workspace-level config, each item drilling into its own
// panel with a back link, instead of a permanently-visible sidebar.
function WorkspaceMenu({
  workspace,
  session,
  open,
  panel,
  onOpenChange,
  onPanelChange,
  onAttach,
  onRewindFiles,
  pending,
  onAddPlugin,
  onRemovePlugin,
  onUpdateTools,
  onUpdateSandbox,
  onAddDirectory,
  onRemoveDirectory,
  onAddAgent,
  onRemoveAgent,
  onUpdateFallbackModel,
  onUpdateSystemPrompt,
  onAddMcpServer,
  onRemoveMcpServer,
  onGetMcpStatus,
  mcpStatus,
}: {
  workspace: Workspace | null;
  session: Session | null;
  open: boolean;
  panel: ComposerPanel;
  onOpenChange: (open: boolean) => void;
  onPanelChange: (panel: ComposerPanel) => void;
  onAttach: () => void;
  onRewindFiles: (sessionId: string) => void;
  pending: boolean;
  onAddPlugin: (workspaceId: string, path: string) => void;
  onRemovePlugin: (workspaceId: string, path: string) => void;
  onUpdateTools: (workspaceId: string, enabledTools: (typeof ToolOptions)[number][]) => void;
  onUpdateSandbox: (workspaceId: string, sandboxed: boolean) => void;
  onAddDirectory: (workspaceId: string, path: string) => void;
  onRemoveDirectory: (workspaceId: string, path: string) => void;
  onAddAgent: (workspaceId: string, agent: AgentDefinition) => void;
  onRemoveAgent: (workspaceId: string, name: string) => void;
  onUpdateFallbackModel: (workspaceId: string, fallbackModel: string) => void;
  onUpdateSystemPrompt: (workspaceId: string, systemPromptAppend: string) => void;
  onAddMcpServer: (workspaceId: string, server: McpServerConfig) => void;
  onRemoveMcpServer: (workspaceId: string, name: string) => void;
  onGetMcpStatus: (sessionId: string) => void;
  mcpStatus: McpStatusEntry[] | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [addingPlugin, setAddingPlugin] = useState(false);
  const [pluginPathDraft, setPluginPathDraft] = useState("");
  const [addingDirectory, setAddingDirectory] = useState(false);
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [addingAgent, setAddingAgent] = useState(false);
  const [agentDraft, setAgentDraft] = useState({ name: "", description: "", prompt: "" });
  const [addingMcp, setAddingMcp] = useState(false);
  const [mcpDraft, setMcpDraft] = useState<{ name: string; type: McpServerConfig["type"]; target: string }>({
    name: "",
    type: "http",
    target: "",
  });
  const [systemPromptDraft, setSystemPromptDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, onOpenChange]);

  function goToMenu() {
    onPanelChange("menu");
    setAddingPlugin(false);
    setAddingDirectory(false);
    setAddingAgent(false);
    setAddingMcp(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          if (open) { onOpenChange(false); return; }
          onPanelChange("menu");
          onOpenChange(true);
        }}
        disabled={pending}
        title="Attachments and workspace settings"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        <PlusIcon />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 max-h-96 w-72 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm">
          {panel === "menu" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  onAttach();
                  onOpenChange(false);
                }}
                className="block w-full px-3 py-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
              >
                Attach file...
              </button>
              {session && (
                <button
                  type="button"
                  onClick={() => {
                    onRewindFiles(session.id);
                    onOpenChange(false);
                  }}
                  title="Restore files to their state before your last message"
                  className="block w-full px-3 py-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
                >
                  Rewind
                </button>
              )}
              {!workspace ? (
                <p className="px-3 py-1.5 font-mono text-xs text-muted-foreground">No workspace selected.</p>
              ) : (
                <>
                  <div className="my-1 border-t border-border" />
                  {WORKSPACE_MENU_ITEMS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onPanelChange(item.key)}
                      className="block w-full px-3 py-1.5 text-left font-mono text-xs text-foreground hover:bg-accent"
                    >
                      {item.label}
                    </button>
                  ))}
                </>
              )}
            </>
          ) : workspace ? (
            <div>
              <button
                type="button"
                onClick={goToMenu}
                className="block w-full border-b border-border px-3 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent"
              >
                ← Back
              </button>
              <div className="p-2">
                {panel === "plugins" && (
                  <>
                    {(workspace.pluginPaths ?? []).map((p) => (
                      <div key={p} className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={p}>
                          {p}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemovePlugin(workspace.id, p)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove plugin ${p}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {addingPlugin ? (
                      <form
                        className="flex gap-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!pluginPathDraft.trim()) return;
                          onAddPlugin(workspace.id, pluginPathDraft.trim());
                          setPluginPathDraft("");
                          setAddingPlugin(false);
                        }}
                      >
                        <input
                          autoFocus
                          value={pluginPathDraft}
                          onChange={(e) => setPluginPathDraft(e.target.value)}
                          onBlur={() => { if (!pluginPathDraft.trim()) setAddingPlugin(false); }}
                          placeholder="/path/to/plugin"
                          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingPlugin(true)}
                        className="block w-full rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        + Add plugin
                      </button>
                    )}
                  </>
                )}

                {panel === "tools" && (
                  <>
                    <div className="flex flex-wrap gap-1 pb-1">
                      {ToolOptions.map((t) => {
                        const enabledSet = new Set(workspace.enabledTools?.length ? workspace.enabledTools : DEFAULT_ENABLED_TOOLS);
                        const on = enabledSet.has(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => {
                              const next = new Set(enabledSet);
                              if (on) next.delete(t);
                              else next.add(t);
                              onUpdateTools(workspace.id, ToolOptions.filter((o) => next.has(o)));
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
                      onClick={() => onUpdateSandbox(workspace.id, !workspace.sandboxed)}
                      className={`rounded-full border px-1.5 py-0.5 font-mono text-xs ${
                        workspace.sandboxed ? "border-primary text-primary" : "border-border text-muted-foreground"
                      }`}
                      title="Run Bash in an OS-level sandbox that restricts filesystem/network access"
                    >
                      Sandboxed Bash
                    </button>
                  </>
                )}

                {panel === "directories" && (
                  <>
                    {(workspace.additionalDirectories ?? []).map((p) => (
                      <div key={p} className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={p}>
                          {p}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemoveDirectory(workspace.id, p)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove directory ${p}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {addingDirectory ? (
                      <form
                        className="flex gap-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!directoryDraft.trim()) return;
                          onAddDirectory(workspace.id, directoryDraft.trim());
                          setDirectoryDraft("");
                          setAddingDirectory(false);
                        }}
                      >
                        <input
                          autoFocus
                          value={directoryDraft}
                          onChange={(e) => setDirectoryDraft(e.target.value)}
                          onBlur={() => { if (!directoryDraft.trim()) setAddingDirectory(false); }}
                          placeholder="/path/to/directory"
                          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingDirectory(true)}
                        className="block w-full rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        + Add directory
                      </button>
                    )}
                  </>
                )}

                {panel === "agents" && (
                  <>
                    {(workspace.agents ?? []).map((a) => (
                      <div key={a.name} className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={a.description}>
                          {a.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => onRemoveAgent(workspace.id, a.name)}
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Remove agent ${a.name}`}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {addingAgent ? (
                      <form
                        className="space-y-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!agentDraft.name.trim() || !agentDraft.description.trim() || !agentDraft.prompt.trim()) return;
                          onAddAgent(workspace.id, { name: agentDraft.name.trim(), description: agentDraft.description.trim(), prompt: agentDraft.prompt.trim() });
                          setAgentDraft({ name: "", description: "", prompt: "" });
                          setAddingAgent(false);
                        }}
                      >
                        <input
                          autoFocus
                          value={agentDraft.name}
                          onChange={(e) => setAgentDraft((d) => ({ ...d, name: e.target.value }))}
                          placeholder="agent name"
                          className="w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <input
                          value={agentDraft.description}
                          onChange={(e) => setAgentDraft((d) => ({ ...d, description: e.target.value }))}
                          placeholder="when to use it"
                          className="w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <textarea
                          value={agentDraft.prompt}
                          onChange={(e) => setAgentDraft((d) => ({ ...d, prompt: e.target.value }))}
                          placeholder="system prompt"
                          rows={2}
                          className="w-full resize-none rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <button type="submit" className="w-full rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                          Save agent
                        </button>
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingAgent(true)}
                        className="block w-full rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        + Add subagent
                      </button>
                    )}
                  </>
                )}

                {panel === "mcp" && (
                  <>
                    {session && (
                      <button
                        type="button"
                        onClick={() => onGetMcpStatus(session.id)}
                        className="mb-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                        title="Refresh live connection status"
                      >
                        ↻ Refresh status
                      </button>
                    )}
                    {(workspace.mcpServers ?? []).map((s) => {
                      const status = mcpStatus?.find((st) => st.name === s.name);
                      return (
                        <div key={s.name} className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-accent">
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
                            onClick={() => onRemoveMcpServer(workspace.id, s.name)}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            aria-label={`Remove MCP server ${s.name}`}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                    {addingMcp ? (
                      <form
                        className="space-y-1 px-1 py-0.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!mcpDraft.name.trim() || !mcpDraft.target.trim()) return;
                          const server: McpServerConfig =
                            mcpDraft.type === "stdio"
                              ? { name: mcpDraft.name.trim(), type: "stdio", ...splitCommand(mcpDraft.target.trim()) }
                              : { name: mcpDraft.name.trim(), type: mcpDraft.type, url: mcpDraft.target.trim() };
                          onAddMcpServer(workspace.id, server);
                          setMcpDraft({ name: "", type: "http", target: "" });
                          setAddingMcp(false);
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
                          onBlur={() => { if (!mcpDraft.name.trim() && !mcpDraft.target.trim()) setAddingMcp(false); }}
                          placeholder={mcpDraft.type === "stdio" ? "command, e.g. npx -y @scope/server" : "https://..."}
                          className="w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setAddingMcp(true)}
                        className="block w-full rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        + Add MCP server
                      </button>
                    )}
                  </>
                )}

                {panel === "fallbackModel" && (
                  <select
                    value={workspace.fallbackModel ?? ""}
                    onChange={(e) => onUpdateFallbackModel(workspace.id, e.target.value)}
                    className="w-full rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">None</option>
                    {ModelOptions.map((m) => (
                      <option key={m} value={m}>{MODEL_LABELS[m]}</option>
                    ))}
                  </select>
                )}

                {panel === "systemPrompt" && (
                  <textarea
                    value={systemPromptDraft ?? workspace.systemPromptAppend ?? ""}
                    onChange={(e) => setSystemPromptDraft(e.target.value)}
                    onBlur={(e) => {
                      if (e.target.value !== (workspace.systemPromptAppend ?? "")) onUpdateSystemPrompt(workspace.id, e.target.value);
                    }}
                    placeholder="Appended to the default system prompt"
                    rows={3}
                    className="w-full resize-none rounded-md border border-input bg-transparent px-1.5 py-0.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
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
      <div className="mb-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
        {attachments && attachments.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {attachments.map((a, i) => (
              <AttachmentChip key={i} name={a.name} />
            ))}
          </div>
        )}
        {text && <p className="whitespace-pre-wrap break-words text-sm">{text}</p>}
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
        {text && <Markdown text={text} className="text-sm" />}
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
  workspace,
  onSend,
  pending,
  streamingText,
  streamingThinking,
  toolProgress,
  onInterrupt,
  permissionRequest,
  onRespondToPermission,
  onRewindFiles,
  rewindResult,
  onBackgroundTask,
  elicitationRequest,
  onRespondToElicitation,
  onAddPlugin,
  onRemovePlugin,
  onUpdateTools,
  onUpdateSandbox,
  onAddDirectory,
  onRemoveDirectory,
  onAddAgent,
  onRemoveAgent,
  onUpdateFallbackModel,
  onUpdateSystemPrompt,
  onAddMcpServer,
  onRemoveMcpServer,
  onGetMcpStatus,
  mcpStatus,
  onGetUsage,
  usageInfo,
}: {
  session: Session | null;
  workspace: Workspace | null;
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
  onInterrupt: (sessionId: string) => void;
  permissionRequest: PermissionRequest | undefined;
  onRespondToPermission: (sessionId: string, requestId: string, allow: boolean) => void;
  onRewindFiles: (sessionId: string) => void;
  rewindResult: RewindResult | undefined;
  onBackgroundTask: (sessionId: string, toolUseId?: string) => void;
  elicitationRequest: ElicitationRequestPayload | undefined;
  onRespondToElicitation: (sessionId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, string>) => void;
  onAddPlugin: (workspaceId: string, path: string) => void;
  onRemovePlugin: (workspaceId: string, path: string) => void;
  onUpdateTools: (workspaceId: string, enabledTools: (typeof ToolOptions)[number][]) => void;
  onUpdateSandbox: (workspaceId: string, sandboxed: boolean) => void;
  onAddDirectory: (workspaceId: string, path: string) => void;
  onRemoveDirectory: (workspaceId: string, path: string) => void;
  onAddAgent: (workspaceId: string, agent: AgentDefinition) => void;
  onRemoveAgent: (workspaceId: string, name: string) => void;
  onUpdateFallbackModel: (workspaceId: string, fallbackModel: string) => void;
  onUpdateSystemPrompt: (workspaceId: string, systemPromptAppend: string) => void;
  onAddMcpServer: (workspaceId: string, server: McpServerConfig) => void;
  onRemoveMcpServer: (workspaceId: string, name: string) => void;
  onGetMcpStatus: (sessionId: string) => void;
  mcpStatus: McpStatusEntry[] | undefined;
  onGetUsage: (sessionId: string) => void;
  usageInfo: UsageInfoPayload | undefined;
}) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<(typeof ModelOptions)[number] | "">("");
  const [permissionMode, setPermissionMode] = useState<(typeof PermissionModeOptions)[number]>("acceptEdits");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerPanel, setComposerPanel] = useState<ComposerPanel>("menu");
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function openComposerPanel(panel: ComposerPanel) {
    setComposerPanel(panel);
    setComposerOpen(true);
  }

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
      ? [...new Set([...LOCAL_COMMANDS, ...(session.slashCommands ?? [])])].filter((c) =>
          c.toLowerCase().startsWith(input.slice(1).toLowerCase())
        )
      : [];
  const showSlashMenu = input.startsWith("/") && !input.includes(" ") && slashMatches.length > 0;

  // returns true if `name` was one of ours and handled — never reaches the agent
  function runLocalCommand(name: string): boolean {
    if (name !== "plugin" && name !== "usage") return false;
    if (name === "plugin") openComposerPanel("plugins");
    if (name === "usage") {
      onGetUsage(session!.id);
      setUsageModalOpen(true);
    }
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

  // same as typing /compact and hitting enter — the CLI's own built-in
  // command handles it, we're just triggering it from the context ring
  function runCompact() {
    if (pending) return;
    onSend(session!.id, "/compact", { model: model || undefined, permissionMode });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {usageModalOpen && <UsageModal usage={usageInfo} onClose={() => setUsageModalOpen(false)} />}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{sessionLabel(session)}</span>
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
                    <div key={t.id} className="flex items-center gap-1">
                      <div className="min-w-0 flex-1">
                        <ToolCallLine call={t} />
                      </div>
                      {!t.result && (
                        <button
                          type="button"
                          onClick={() => onBackgroundTask(session.id, t.id)}
                          className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground"
                          title="Move this to the background and keep going"
                        >
                          background
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {elicitationRequest ? (
                <ElicitationCard
                  request={elicitationRequest}
                  onRespond={(action, content) => onRespondToElicitation(session.id, elicitationRequest.requestId, action, content)}
                />
              ) : permissionRequest ? (
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
                <Markdown text={streamingText} className="text-sm" />
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
              <WorkspaceMenu
                workspace={workspace}
                session={session}
                open={composerOpen}
                panel={composerPanel}
                onOpenChange={setComposerOpen}
                onPanelChange={setComposerPanel}
                onAttach={() => fileInputRef.current?.click()}
                onRewindFiles={onRewindFiles}
                pending={pending}
                onAddPlugin={onAddPlugin}
                onRemovePlugin={onRemovePlugin}
                onUpdateTools={onUpdateTools}
                onUpdateSandbox={onUpdateSandbox}
                onAddDirectory={onAddDirectory}
                onRemoveDirectory={onRemoveDirectory}
                onAddAgent={onAddAgent}
                onRemoveAgent={onRemoveAgent}
                onUpdateFallbackModel={onUpdateFallbackModel}
                onUpdateSystemPrompt={onUpdateSystemPrompt}
                onAddMcpServer={onAddMcpServer}
                onRemoveMcpServer={onRemoveMcpServer}
                onGetMcpStatus={onGetMcpStatus}
                mcpStatus={mcpStatus}
              />

              {session.contextUsage !== undefined && (
                <ContextRing percentage={session.contextUsage.percentage} onClick={runCompact} />
              )}

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
