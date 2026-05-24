import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import {
  codexIdentityKey,
  codexSourceAgentId,
  hookServerUrl,
} from "@agent-office/protocol";

const inputResult = await readStdin({ maxBytes: 1024 * 1024 });
if (!inputResult.ok) {
  await logAdapterError({ message: inputResult.error });
  writeCodexHookSuccess();
  process.exit(0);
}

const inputParseResult = parseCodexHookInput({ text: inputResult.text });
if (!inputParseResult.ok) {
  await logAdapterError({ message: inputParseResult.error });
  writeCodexHookSuccess();
  process.exit(0);
}

const eventResult = mapCodexHookToOfficeEvent({ input: inputParseResult.input });
if (!eventResult.ok) {
  await logAdapterError({ message: eventResult.error });
  writeCodexHookSuccess();
  process.exit(0);
}

const tokenResult = await readHookToken();
if (!tokenResult.ok) {
  await logAdapterError({ message: tokenResult.error });
  writeCodexHookSuccess();
  process.exit(0);
}

const postResult = await postOfficeEvent({
  event: eventResult.event,
  token: tokenResult.token,
});
if (!postResult.ok) {
  await logAdapterError({ message: postResult.error });
}

writeCodexHookSuccess();

function readStdin(params) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;

    process.stdin.on("data", (chunk) => {
      received += chunk.length;
      if (received > params.maxBytes) {
        resolve({ ok: false, error: "Codex hook input exceeded 1 MiB" });
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });

    process.stdin.on("end", () => {
      resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });

    process.stdin.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

function parseCodexHookInput(params) {
  let value;
  try {
    value = JSON.parse(params.text);
  } catch (error) {
    return { ok: false, error: `Codex hook input is not valid JSON: ${error.message}` };
  }

  if (!isRecord({ value })) {
    return { ok: false, error: "Codex hook input must be a JSON object" };
  }
  if (typeof value.hook_event_name !== "string" || value.hook_event_name.trim().length === 0) {
    return { ok: false, error: "Codex hook input requires string field hook_event_name" };
  }

  const workspace = readWorkspace({ input: value });
  if (workspace === undefined) {
    return { ok: false, error: "Codex hook input requires cwd" };
  }

  return { ok: true, input: { ...value, workspace } };
}

function readWorkspace(params) {
  if (typeof params.input.cwd === "string" && params.input.cwd.trim().length > 0) {
    return path.resolve(params.input.cwd);
  }
  return undefined;
}

function mapCodexHookToOfficeEvent(params) {
  const officeEvent = mapOfficeEventName({ codexEventName: params.input.hook_event_name });
  if (officeEvent === undefined) {
    return { ok: false, error: `Unsupported Codex hook event: ${params.input.hook_event_name}` };
  }

  const sessionId = readOptionalString({ source: params.input, key: "session_id" });
  if (sessionId === undefined) {
    return { ok: false, error: "Codex hook input requires session_id for session visualization" };
  }

  const identity = selectAgentIdentity({
    input: params.input,
    sessionId,
  });

  return {
    ok: true,
    event: {
      id: crypto.randomUUID(),
      agentId: identity.agentId,
      workspace: params.input.workspace,
      event: officeEvent,
      taskId: sessionId,
      title: createTitle({ input: params.input, officeEvent }),
      timestamp: new Date().toISOString(),
      details: createDetails({ input: params.input, identity }),
    },
  };
}

function mapOfficeEventName(params) {
  if (params.codexEventName === "UserPromptSubmit" || params.codexEventName === "SubagentStart") {
    return "task_started";
  }
  if (params.codexEventName === "Stop" || params.codexEventName === "SubagentStop") {
    return "task_completed";
  }
  if (params.codexEventName === "PermissionRequest") {
    return "user_input_required";
  }
  if (params.codexEventName === "SessionStart" || params.codexEventName === "PostCompact") {
    return "agent_idle";
  }
  if (params.codexEventName === "PreCompact") {
    return "task_blocked";
  }
  return undefined;
}

function selectAgentIdentity(params) {
  const codexAgentId = readOptionalString({ source: params.input, key: "agent_id" });
  const isSubagent = params.input.hook_event_name === "SubagentStart"
    || params.input.hook_event_name === "SubagentStop"
    || codexAgentId !== undefined;

  return {
    agentId: createSessionAgentId({
      sourceAgentId: codexSourceAgentId,
      sessionId: params.sessionId,
      identityKey: codexIdentityKey,
    }),
    sourceAgentId: codexSourceAgentId,
    identityKey: codexIdentityKey,
    codexAgentKind: isSubagent ? "subagent" : "main",
  };
}

function createSessionAgentId(params) {
  const digest = crypto
    .createHash("sha256")
    .update(`${params.sourceAgentId}\n${params.sessionId}\n${params.identityKey}`)
    .digest("hex")
    .slice(0, 10);
  return `${params.sourceAgentId}-session-${digest}`;
}

function createTitle(params) {
  if (params.input.hook_event_name === "UserPromptSubmit" && typeof params.input.prompt === "string" && params.input.prompt.trim().length > 0) {
    return truncate({ value: params.input.prompt.trim(), maxLength: 96 });
  }
  if (params.input.hook_event_name === "PermissionRequest" && typeof params.input.tool_name === "string") {
    return `需要授权: ${params.input.tool_name}`;
  }
  if ((params.input.hook_event_name === "Stop" || params.input.hook_event_name === "SubagentStop") && typeof params.input.last_assistant_message === "string" && params.input.last_assistant_message.trim().length > 0) {
    return truncate({ value: params.input.last_assistant_message.trim(), maxLength: 96 });
  }
  if (params.input.hook_event_name === "SessionStart" && typeof params.input.source === "string") {
    return `Codex 会话 ${params.input.source}`;
  }

  const labels = {
    task_started: "Codex 开始任务",
    task_completed: "Codex 完成任务",
    task_blocked: "Codex 正在压缩上下文",
    user_input_required: "Codex 需要授权",
    agent_idle: "Codex 空闲",
  };
  return labels[params.officeEvent];
}

function createDetails(params) {
  return {
    codexHookEventName: params.input.hook_event_name,
    codexSessionId: readOptionalString({ source: params.input, key: "session_id" }),
    codexTurnId: readOptionalString({ source: params.input, key: "turn_id" }),
    codexAgentId: readOptionalString({ source: params.input, key: "agent_id" }),
    codexAgentType: readOptionalString({ source: params.input, key: "agent_type" }),
    codexSourceAgentId: params.identity.sourceAgentId,
    codexIdentityKey: params.identity.identityKey,
    codexAgentKind: params.identity.codexAgentKind,
    model: readOptionalString({ source: params.input, key: "model" }),
    permissionMode: readOptionalString({ source: params.input, key: "permission_mode" }),
    toolName: readOptionalString({ source: params.input, key: "tool_name" }),
  };
}

async function postOfficeEvent(params) {
  let response;
  try {
    response = await fetch(`${hookServerUrl}/hook`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.event),
      signal: AbortSignal.timeout(1500),
    });
  } catch (error) {
    return { ok: false, error: `Cannot reach Agent Office hook server: ${error.message}` };
  }

  if (!response.ok) {
    return { ok: false, error: `Agent Office hook server rejected event with ${response.status}: ${await response.text()}` };
  }

  return { ok: true };
}

async function readHookToken() {
  const tokenPath = hookTokenPath();
  let token;
  try {
    token = await fs.readFile(tokenPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Cannot read Agent Office hook token at ${tokenPath}: start the Agent Office desktop app first. ${error.message}` };
  }

  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `Agent Office hook token is empty at ${tokenPath}` };
  }
  return { ok: true, token: trimmed };
}

function hookTokenPath() {
  return path.join(agentOfficeStateDir(), "hook-token");
}

function agentOfficeStateDir() {
  return path.join(os.homedir(), ".agent-office");
}

function truncate(params) {
  if (params.value.length <= params.maxLength) {
    return params.value;
  }
  return `${params.value.slice(0, params.maxLength - 3)}...`;
}

function readOptionalString(params) {
  const value = params.source[params.key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function writeCodexHookSuccess() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function logAdapterError(params) {
  const logDir = path.join(agentOfficeStateDir(), "logs");
  const logPath = path.join(logDir, "hook-errors.log");
  const line = `${formatBeijingTimestamp({ date: new Date() })} ${params.message}\n`;
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, line, "utf8");
  } catch {
    return;
  }
}

function formatBeijingTimestamp(params) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(params.date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const millisecond = String(params.date.getUTCMilliseconds()).padStart(3, "0");
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${millisecond} Asia/Shanghai`;
}

function isRecord(params) {
  return typeof params.value === "object" && params.value !== null && !Array.isArray(params.value);
}
