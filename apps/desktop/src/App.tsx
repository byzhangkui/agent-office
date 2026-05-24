import {
  RefreshCw,
  Activity,
  ScrollText,
} from "lucide-react";
import { useState } from "react";
import { OfficeCanvas } from "./OfficeCanvas";
import "./app.css";
import { useTauriBridge } from "./useTauriBridge";
import { useOfficeStore } from "./store";
import type { BridgeLogItem } from "./types";

type ActivityView = "events" | "logs";

export default function App(): JSX.Element {
  useTauriBridge();
  const [activityView, setActivityView] = useState<ActivityView>("logs");
  const [activityOpen, setActivityOpen] = useState(false);

  const agents = useOfficeStore((state) => state.agents);
  const eventLog = useOfficeStore((state) => state.eventLog);
  const bridgeLogs = useOfficeStore((state) => state.bridgeLogs);
  const bridgeStatus = useOfficeStore((state) => state.bridgeStatus);
  const bridgeError = useOfficeStore((state) => state.bridgeError);
  const loadBridgeLogs = useOfficeStore((state) => state.loadBridgeLogs);

  const activeCount = agents.filter((agent) => agent.status === "working").length;
  const blockedCount = agents.filter((agent) => agent.status === "blocked" || agent.status === "waiting").length;
  const idleCount = agents.length - activeCount - blockedCount;

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
          </div>
        </header>

        <OfficeCanvas />
      </section>

      <aside className="side-panel" aria-label="运行记录">
        <button
          className="activity-toggle"
          type="button"
          onClick={() => setActivityOpen((open) => !open)}
          aria-expanded={activityOpen}
          aria-label={activityOpen ? "隐藏运行记录" : "显示运行记录"}
          title={activityOpen ? "隐藏运行记录" : "显示运行记录"}
        >
          {activityOpen ? <Activity size={17} /> : <ScrollText size={17} />}
          <span>{activityOpen ? "隐藏" : "记录"}</span>
        </button>

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
    </main>
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
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(params.iso));
}
