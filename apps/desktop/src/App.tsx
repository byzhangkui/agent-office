import {
  RefreshCw,
  Activity,
  ScrollText,
  Settings,
  X,
  Link2,
  Link2Off,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { OfficeCanvas } from "./OfficeCanvas";
import "./app.css";
import { useTauriBridge } from "./useTauriBridge";
import { useOfficeStore } from "./store";
import {
  fetchClaudeHookSettings,
  fetchCodexHookSettings,
  listenForOpenSettings,
  registerClaudeHooks,
  registerCodexHooks,
  unregisterClaudeHooks,
  unregisterCodexHooks,
} from "./tauriBridge";
import type { BridgeLogItem, ClaudeHookSettings, CodexHookSettings } from "./types";

type ActivityView = "events" | "logs";
const beijingTimeZone = "Asia/Shanghai";

export default function App(): JSX.Element {
  useTauriBridge();
  const [activityView, setActivityView] = useState<ActivityView>("logs");
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const agents = useOfficeStore((state) => state.agents);
  const eventLog = useOfficeStore((state) => state.eventLog);
  const bridgeLogs = useOfficeStore((state) => state.bridgeLogs);
  const bridgeStatus = useOfficeStore((state) => state.bridgeStatus);
  const bridgeError = useOfficeStore((state) => state.bridgeError);
  const loadBridgeLogs = useOfficeStore((state) => state.loadBridgeLogs);

  const activeCount = agents.filter((agent) => agent.status === "working").length;
  const blockedCount = agents.filter((agent) => agent.status === "blocked" || agent.status === "waiting").length;
  const idleCount = agents.length - activeCount - blockedCount;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenForOpenSettings({
      onOpen: () => setSettingsOpen(true),
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <main className={`app-shell ${activityOpen ? "activity-open" : "activity-closed"}`}>
      <section className="scene-panel" aria-label="Agent office animation">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="app-mark">AO</div>
            <div>
              <h1>Agent Office</h1>
              <p>{activeCount} 工作中 · {blockedCount} 等待 · {idleCount} 空闲/走动</p>
            </div>
          </div>

          <div className="toolbar">
            <span className={`bridge-pill bridge-${bridgeStatus}`}>
              {formatBridgeStatus({ status: bridgeStatus })}
            </span>
            <button className="mini-icon-button" type="button" onClick={() => setSettingsOpen(true)} title="设置" aria-label="设置">
              <Settings size={15} />
            </button>
            <button
              className="activity-toggle"
              type="button"
              onClick={() => setActivityOpen((open) => !open)}
              aria-expanded={activityOpen}
              aria-label={activityOpen ? "隐藏运行记录" : "显示运行记录"}
              title={activityOpen ? "隐藏运行记录" : "显示运行记录"}
            >
              {activityOpen ? <Activity size={16} /> : <ScrollText size={16} />}
              <span>{activityOpen ? "隐藏" : "记录"}</span>
            </button>
          </div>
        </header>

        <OfficeCanvas />
      </section>

      <aside className="side-panel" aria-label="运行记录">
        {activityOpen ? (
          <section className="event-log">
            <div className="section-title">
              {activityView === "logs" ? <ScrollText size={18} /> : <Activity size={18} />}
              <h2>运行记录</h2>
              <button className="mini-icon-button" type="button" onClick={() => void loadBridgeLogs()} title="刷新日志" aria-label="刷新日志">
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="activity-tabs" role="tablist" aria-label="运行记录视图">
              <button className={activityView === "events" ? "selected" : ""} type="button" onClick={() => setActivityView("events")}>
                事件
              </button>
              <button className={activityView === "logs" ? "selected" : ""} type="button" onClick={() => setActivityView("logs")}>
                日志
              </button>
            </div>
            {bridgeError === undefined ? undefined : <p className="bridge-error">{bridgeError}</p>}
            {activityView === "events" ? (
              <div className="event-list">
                {eventLog.length === 0 ? <p className="empty-state">暂无 hook 事件</p> : undefined}
                {eventLog.map((item) => (
                  <article key={item.id} className="event-item">
                    <time>{formatClock({ iso: item.timestamp })}</time>
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </article>
                ))}
              </div>
            ) : (
              <div className="event-list">
                {bridgeLogs.length === 0 ? <p className="empty-state">暂无 hook 日志</p> : undefined}
                {bridgeLogs.map((item) => (
                  <BridgeLogEntry key={item.id} item={item} />
                ))}
              </div>
            )}
        </section>
        ) : undefined}
      </aside>
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : undefined}
    </main>
  );
}

type HookSource = "codex" | "claude";

function SettingsPanel(params: { onClose: () => void }): JSX.Element {
  const [source, setSource] = useState<HookSource>("codex");
  const [codexSettings, setCodexSettings] = useState<CodexHookSettings | undefined>(undefined);
  const [claudeSettings, setClaudeSettings] = useState<ClaudeHookSettings | undefined>(undefined);
  const [busy, setBusy] = useState<"register" | "unregister" | "refresh" | undefined>("refresh");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const settings = source === "codex" ? codexSettings : claudeSettings;

  const loadSettings = useCallback(async (target: HookSource) => {
    setBusy("refresh");
    setError(undefined);
    if (target === "codex") {
      const result = await fetchCodexHookSettings();
      if (result.ok) {
        setCodexSettings(result.settings);
      } else {
        setError(result.error);
      }
    } else {
      const result = await fetchClaudeHookSettings();
      if (result.ok) {
        setClaudeSettings(result.settings);
      } else {
        setError(result.error);
      }
    }
    setBusy(undefined);
  }, []);

  useEffect(() => {
    setMessage(undefined);
    void loadSettings(source);
  }, [loadSettings, source]);

  const runRegister = async (): Promise<void> => {
    setBusy("register");
    setError(undefined);
    setMessage(undefined);
    if (source === "codex") {
      const result = await registerCodexHooks();
      if (result.ok) {
        setCodexSettings(result.result.settings);
        setMessage(result.result.message);
      } else {
        setError(result.error);
      }
    } else {
      const result = await registerClaudeHooks();
      if (result.ok) {
        setClaudeSettings(result.result.settings);
        setMessage(result.result.message);
      } else {
        setError(result.error);
      }
    }
    setBusy(undefined);
  };

  const runUnregister = async (): Promise<void> => {
    setBusy("unregister");
    setError(undefined);
    setMessage(undefined);
    if (source === "codex") {
      const result = await unregisterCodexHooks();
      if (result.ok) {
        setCodexSettings(result.result.settings);
        setMessage(result.result.message);
      } else {
        setError(result.error);
      }
    } else {
      const result = await unregisterClaudeHooks();
      if (result.ok) {
        setClaudeSettings(result.result.settings);
        setMessage(result.result.message);
      } else {
        setError(result.error);
      }
    }
    setBusy(undefined);
  };

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-panel" aria-label="设置">
        <header className="settings-header">
          <div className="section-title">
            <Settings size={18} />
            <h2>设置</h2>
          </div>
          <button className="mini-icon-button" type="button" onClick={params.onClose} title="关闭" aria-label="关闭">
            <X size={15} />
          </button>
        </header>

        <div className="settings-source-tabs" role="tablist" aria-label="Agent 来源">
          <button
            className={`settings-source-tab${source === "codex" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={source === "codex"}
            disabled={busy !== undefined}
            onClick={() => setSource("codex")}
          >
            Codex
          </button>
          <button
            className={`settings-source-tab${source === "claude" ? " active" : ""}`}
            type="button"
            role="tab"
            aria-selected={source === "claude"}
            disabled={busy !== undefined}
            onClick={() => setSource("claude")}
          >
            Claude Code
          </button>
        </div>

        <div className="settings-status-line">
          {settings === undefined ? (
            <span className="status status-neutral">读取中</span>
          ) : settings.installed ? (
            <span className="status status-active"><CheckCircle2 size={14} /> 已注册</span>
          ) : (
            <span className="status status-warning"><AlertTriangle size={14} /> 未完整注册</span>
          )}
          {message === undefined ? undefined : <span className="settings-message">{message}</span>}
        </div>

        {error === undefined ? undefined : <p className="bridge-error">{error}</p>}

        <div className="settings-actions">
          <button className="settings-action primary" type="button" disabled={busy !== undefined} onClick={() => void runRegister()}>
            <Link2 size={16} />
            <span>{busy === "register" ? "注册中" : "注册 hooks"}</span>
          </button>
          <button className="settings-action" type="button" disabled={busy !== undefined || settings?.registeredEvents.length === 0} onClick={() => void runUnregister()}>
            <Link2Off size={16} />
            <span>{busy === "unregister" ? "取消中" : "取消注册"}</span>
          </button>
          <button className="mini-icon-button" type="button" disabled={busy !== undefined} onClick={() => void loadSettings(source)} title="刷新" aria-label="刷新">
            <RefreshCw size={14} />
          </button>
        </div>

        {source === "codex"
          ? codexSettings === undefined
            ? undefined
            : <CodexSettingsGrid settings={codexSettings} />
          : claudeSettings === undefined
            ? undefined
            : <ClaudeSettingsGrid settings={claudeSettings} />}
      </section>
    </div>
  );
}

function CodexSettingsGrid(params: { settings: CodexHookSettings }): JSX.Element {
  const { settings } = params;
  return (
    <div className="settings-grid">
      <SettingsRow label="Codex hooks" value={settings.hooksEnabled ? "开启" : "关闭"} tone={settings.hooksEnabled ? "active" : "danger"} />
      <SettingsRow label="Plugin hooks" value={settings.pluginHooksEnabled ? "开启" : "关闭"} tone={settings.pluginHooksEnabled ? "active" : "warning"} />
      <SettingsRow label="事件" value={`${settings.registeredEvents.length}/${settings.registeredEvents.length + settings.missingEvents.length}`} tone={settings.missingEvents.length === 0 ? "active" : "warning"} />
      <SettingsRow label="Adapter" value={settings.adapterExists ? "存在" : "缺失"} tone={settings.adapterExists ? "active" : "danger"} />
      <PathRow label="Codex home" value={settings.codexHome} />
      <PathRow label="hooks.json" value={settings.hooksPath} />
      <PathRow label="config.toml" value={settings.configPath} />
      <PathRow label="Adapter path" value={settings.adapterPath} />
      {settings.missingEvents.length === 0 ? undefined : (
        <PathRow label="缺失事件" value={settings.missingEvents.join(", ")} />
      )}
      {settings.lastErrorLog === undefined ? undefined : (
        <div className="settings-log">
          <span>Adapter errors</span>
          <pre>{formatAdapterErrorLog({ text: settings.lastErrorLog })}</pre>
        </div>
      )}
    </div>
  );
}

function ClaudeSettingsGrid(params: { settings: ClaudeHookSettings }): JSX.Element {
  const { settings } = params;
  return (
    <div className="settings-grid">
      <SettingsRow label="事件" value={`${settings.registeredEvents.length}/${settings.registeredEvents.length + settings.missingEvents.length}`} tone={settings.missingEvents.length === 0 ? "active" : "warning"} />
      <SettingsRow label="Adapter" value={settings.adapterExists ? "存在" : "缺失"} tone={settings.adapterExists ? "active" : "danger"} />
      <SettingsRow label="settings.json" value={settings.settingsFileExists ? "存在" : "缺失"} tone={settings.settingsFileExists ? "active" : "warning"} />
      <PathRow label="Claude home" value={settings.claudeHome} />
      <PathRow label="settings.json" value={settings.settingsPath} />
      <PathRow label="Adapter path" value={settings.adapterPath} />
      {settings.missingEvents.length === 0 ? undefined : (
        <PathRow label="缺失事件" value={settings.missingEvents.join(", ")} />
      )}
      {settings.lastErrorLog === undefined ? undefined : (
        <div className="settings-log">
          <span>Adapter errors</span>
          <pre>{formatAdapterErrorLog({ text: settings.lastErrorLog })}</pre>
        </div>
      )}
    </div>
  );
}

function SettingsRow(params: { label: string; value: string; tone: "active" | "warning" | "danger" }): JSX.Element {
  return (
    <div className="settings-row">
      <span>{params.label}</span>
      <strong className={`status status-${params.tone}`}>{params.value}</strong>
    </div>
  );
}

function PathRow(params: { label: string; value: string }): JSX.Element {
  return (
    <div className="settings-row settings-path-row">
      <span>{params.label}</span>
      <code>{params.value}</code>
    </div>
  );
}

function BridgeLogEntry(params: { item: BridgeLogItem }): JSX.Element {
  const detailText = formatDetails({ details: params.item.details });
  return (
    <article className={`log-item log-${params.item.level}`}>
      <div className="log-meta">
        <time>{formatClock({ iso: params.item.timestamp })}</time>
        <span>{params.item.level}</span>
        {params.item.statusCode === undefined ? undefined : <span>{params.item.statusCode}</span>}
      </div>
      <strong>{params.item.message}</strong>
      <span>{formatLogScope({ item: params.item })}</span>
      {detailText === undefined ? undefined : <pre>{detailText}</pre>}
    </article>
  );
}

function formatBridgeStatus(params: { status: string }): string {
  const labels: Record<string, string> = {
    connecting: "连接中",
    connected: "已连接",
    disconnected: "已断开",
    error: "异常",
  };
  return labels[params.status] ?? params.status;
}

function formatLogScope(params: { item: BridgeLogItem }): string {
  const parts = [params.item.source, params.item.event, params.item.agentId, params.item.workspace].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "hook-server" : parts.join(" · ");
}

function formatDetails(params: { details: Record<string, unknown> }): string | undefined {
  const entries = Object.entries(params.details).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return undefined;
  }
  return JSON.stringify(Object.fromEntries(entries), undefined, 2);
}

function formatClock(params: { iso: string }): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: beijingTimeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(params.iso));
}

function formatAdapterErrorLog(params: { text: string }): string {
  return params.text
    .split("\n")
    .map((line) => line.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)(\s+)/, (_match, iso: string, whitespace: string) => {
      return `${formatBeijingDateTime({ iso })} ${beijingTimeZone}${whitespace}`;
    }))
    .join("\n");
}

function formatBeijingDateTime(params: { iso: string }): string {
  const date = new Date(params.iso);
  if (Number.isNaN(date.getTime())) {
    return params.iso;
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: beijingTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${milliseconds}`;
}
