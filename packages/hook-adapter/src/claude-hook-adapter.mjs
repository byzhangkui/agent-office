import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import {
  agentIdentityDetailKey,
  agentSessionIdDetailKey,
  agentSourceIdDetailKey,
  claudeIdentityKey,
  claudeSourceAgentId,
  hookServerUrl,
} from "@agent-office/protocol";

const inputResult = await readStdin({ maxBytes: 1024 * 1024 });
if (!inputResult.ok) {
  await logAdapterError({ message: inputResult.error });
  writeClaudeHookSuccess();
  process.exit(0);
}

const inputParseResult = parseClaudeHookInput({ text: inputResult.text });
if (!inputParseResult.ok) {
  await logAdapterError({ message: inputParseResult.error });
  writeClaudeHookSuccess();
  process.exit(0);
}

const eventResult = mapClaudeHookToOfficeEvent({ input: inputParseResult.input });
if (!eventResult.ok) {
  await logAdapterError({ message: eventResult.error });
  writeClaudeHookSuccess();
  process.exit(0);
}

const tokenResult = await readHookToken();
if (!tokenResult.ok) {
  await logAdapterError({ message: tokenResult.error });
  writeClaudeHookSuccess();
  process.exit(0);
}

const postResult = await postOfficeEvent({
  event: eventResult.event,
  token: tokenResult.token,
});
if (!postResult.ok) {
  await logAdapterError({ message: postResult.error });
}

writeClaudeHookSuccess();

function readStdin(params) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;

    process.stdin.on("data", (chunk) => {
      received += chunk.length;
      if (received > params.maxBytes) {
        resolve({ ok: false, error: "Claude hook input exceeded 1 MiB" });
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

function parseClaudeHookInput(params) {
  let value;
  try {
    value = JSON.parse(params.text);
  } catch (error) {
    return { ok: false, error: `Claude hook input is not valid JSON: ${error.message}` };
  }

  if (!isRecord({ value })) {
    return { ok: false, error: "Claude hook input must be a JSON object" };
  }
  if (typeof value.hook_event_name !== "string" || value.hook_event_name.trim().length === 0) {
    return { ok: false, error: "Claude hook input requires string field hook_event_name" };
  }

  const workspace = readWorkspace({ input: value });
  if (workspace === undefined) {
    return { ok: false, error: "Claude hook input requires cwd" };
  }

  return { ok: true, input: { ...value, workspace } };
}

function readWorkspace(params) {
  if (typeof params.input.cwd === "string" && params.input.cwd.trim().length > 0) {
    return path.resolve(params.input.cwd);
  }
  return undefined;
}

function mapClaudeHookToOfficeEvent(params) {
  const officeEvent = mapOfficeEventName({ claudeEventName: params.input.hook_event_name });
  if (officeEvent === undefined) {
    return { ok: false, error: `Unsupported Claude hook event: ${params.input.hook_event_name}` };
  }

  const sessionId = readOptionalString({ source: params.input, key: "session_id" });
  if (sessionId === undefined) {
    return { ok: false, error: "Claude hook input requires session_id for session visualization" };
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
  if (params.claudeEventName === "UserPromptSubmit") {
    return "task_started";
  }
  if (params.claudeEventName === "Stop" || params.claudeEventName === "SubagentStop") {
    return "task_completed";
  }
  if (params.claudeEventName === "Notification") {
    return "user_input_required";
  }
  if (params.claudeEventName === "SessionStart") {
    return "agent_idle";
  }
  if (params.claudeEventName === "PreCompact") {
    return "task_blocked";
  }
  return undefined;
}

function selectAgentIdentity(params) {
  const isSubagent = params.input.hook_event_name === "SubagentStop";

  return {
    agentId: createSessionAgentId({
      sourceAgentId: claudeSourceAgentId,
      sessionId: params.sessionId,
      identityKey: claudeIdentityKey,
    }),
    sourceAgentId: claudeSourceAgentId,
    sessionId: params.sessionId,
    identityKey: claudeIdentityKey,
    claudeAgentKind: isSubagent ? "subagent" : "main",
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
  if (params.input.hook_event_name === "Notification" && typeof params.input.message === "string" && params.input.message.trim().length > 0) {
    return truncate({ value: params.input.message.trim(), maxLength: 96 });
  }
  if (params.input.hook_event_name === "SessionStart" && typeof params.input.source === "string") {
    return `Claude 会话 ${params.input.source}`;
  }

  const labels = {
    task_started: "Claude 开始任务",
    task_completed: "Claude 完成任务",
    task_blocked: "Claude 正在压缩上下文",
    user_input_required: "Claude 需要输入",
    agent_idle: "Claude 空闲",
  };
  return labels[params.officeEvent];
}

function createDetails(params) {
  return {
    [agentSourceIdDetailKey]: params.identity.sourceAgentId,
    [agentSessionIdDetailKey]: params.identity.sessionId,
    [agentIdentityDetailKey]: params.identity.identityKey,
    claudeHookEventName: params.input.hook_event_name,
    claudeAgentKind: params.identity.claudeAgentKind,
    claudeTranscriptPath: readOptionalString({ source: params.input, key: "transcript_path" }),
    permissionMode: readOptionalString({ source: params.input, key: "permission_mode" }),
    notificationMessage: readOptionalString({ source: params.input, key: "message" }),
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

function writeClaudeHookSuccess() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function logAdapterError(params) {
  const logDir = path.join(agentOfficeStateDir(), "logs");
  const logPath = path.join(logDir, "hook-errors.log");
  const line = `${new Date().toISOString()} ${params.message}\n`;
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logPath, line, "utf8");
  } catch {
    return;
  }
}

function isRecord(params) {
  return typeof params.value === "object" && params.value !== null && !Array.isArray(params.value);
}
