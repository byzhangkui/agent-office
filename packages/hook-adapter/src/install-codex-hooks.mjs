import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs({ argv: process.argv.slice(2) });

if (args.codexHome === undefined) {
  fail({ message: "Missing --codex-home" });
}
if (args.adapter === undefined) {
  fail({ message: "Missing --adapter" });
}

const codexHome = path.resolve(expandHome({ value: args.codexHome }));
const adapterPath = path.resolve(args.adapter);
const hooksPath = path.join(codexHome, "hooks.json");

await assertDirectory({ directoryPath: codexHome, label: "Codex home" });
await assertReadableFile({ filePath: path.join(codexHome, "config.toml"), label: "Codex config" });
await assertReadableFile({ filePath: adapterPath, label: "Codex hook adapter" });

const existingHooks = await readExistingHooks({ hooksPath });
const command = buildAdapterCommand({ adapterPath });
const nextHooks = mergeAgentOfficeHooks({ existingHooks, command, adapterPath });

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify(nextHooks, null, 2)}\n`);
  process.exit(0);
}

let backupPath;
if (await fileExists({ filePath: hooksPath })) {
  backupPath = createBackupPath({ hooksPath });
  await fs.copyFile(hooksPath, backupPath);
}

await fs.writeFile(hooksPath, `${JSON.stringify(nextHooks, null, 2)}\n`, "utf8");

if (backupPath === undefined) {
  process.stdout.write(`Wrote ${hooksPath}\n`);
} else {
  process.stdout.write(`Updated ${hooksPath}\nBackup: ${backupPath}\n`);
}
process.stdout.write("Codex will ask you to review and trust these hooks on next interactive startup.\n");

function parseArgs(params) {
  const parsed = { dryRun: false };
  for (let index = 0; index < params.argv.length; index += 1) {
    const current = params.argv[index];
    const next = params.argv[index + 1];
    if (current === "--codex-home" && next !== undefined) {
      parsed.codexHome = next;
      index += 1;
    } else if (current === "--adapter" && next !== undefined) {
      parsed.adapter = next;
      index += 1;
    } else if (current === "--dry-run") {
      parsed.dryRun = true;
    }
  }
  return parsed;
}

async function assertDirectory(params) {
  try {
    const stat = await fs.stat(params.directoryPath);
    if (!stat.isDirectory()) {
      fail({ message: `${params.label} path is not a directory: ${params.directoryPath}` });
    }
  } catch (error) {
    fail({ message: `${params.label} is not readable at ${params.directoryPath}: ${error.message}` });
  }
}

async function assertReadableFile(params) {
  try {
    const stat = await fs.stat(params.filePath);
    if (!stat.isFile()) {
      fail({ message: `${params.label} path is not a file: ${params.filePath}` });
    }
  } catch (error) {
    fail({ message: `${params.label} is not readable at ${params.filePath}: ${error.message}` });
  }
}

async function readExistingHooks(params) {
  if (!(await fileExists({ filePath: params.hooksPath }))) {
    return { hooks: {} };
  }

  let raw;
  try {
    raw = await fs.readFile(params.hooksPath, "utf8");
  } catch (error) {
    fail({ message: `Cannot read existing Codex hooks at ${params.hooksPath}: ${error.message}` });
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail({ message: `Existing Codex hooks file is not valid JSON: ${error.message}` });
  }

  if (!isRecord({ value })) {
    fail({ message: "Existing Codex hooks file must be a JSON object" });
  }
  if (value.hooks !== undefined && !isRecord({ value: value.hooks })) {
    fail({ message: "Existing Codex hooks file field hooks must be an object" });
  }

  return {
    ...value,
    hooks: value.hooks ?? {},
  };
}

function mergeAgentOfficeHooks(params) {
  const next = structuredClone(params.existingHooks);
  next.hooks = isRecord({ value: next.hooks }) ? next.hooks : {};

  for (const eventName of hookEventsToInstall()) {
    const entries = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    next.hooks[eventName] = appendHookEntry({
      entries: entries.filter((entry) => !isAgentOfficeHookEntry({ entry, adapterPath: params.adapterPath })),
      eventName,
      command: params.command,
    });
  }

  return next;
}

function hookEventsToInstall() {
  return [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "SubagentStart",
    "SubagentStop",
  ];
}

function isAgentOfficeHookEntry(params) {
  if (!isRecord({ value: params.entry }) || !Array.isArray(params.entry.hooks)) {
    return false;
  }
  return params.entry.hooks.some((hook) => {
    if (!isRecord({ value: hook }) || hook.type !== "command" || typeof hook.command !== "string") {
      return false;
    }
    return hook.command.includes(params.adapterPath)
      || hook.command.includes("scripts/codex-hook-adapter.mjs")
      || hook.command.includes("packages/hook-adapter/src/codex-hook-adapter.mjs");
  });
}

function appendHookEntry(params) {
  const matcher = matcherForEvent({ eventName: params.eventName });
  const existing = params.entries.some((entry) => {
    if (!isRecord({ value: entry }) || !Array.isArray(entry.hooks)) {
      return false;
    }
    return entry.hooks.some((hook) => {
      return isRecord({ value: hook }) && hook.type === "command" && hook.command === params.command;
    });
  });

  if (existing) {
    return params.entries;
  }

  const entry = {
    hooks: [
      {
        type: "command",
        command: params.command,
        timeout: 2,
        statusMessage: "notify Agent Office",
      },
    ],
  };
  if (matcher !== undefined) {
    entry.matcher = matcher;
  }

  return [...params.entries, entry];
}

function matcherForEvent(params) {
  if (params.eventName === "UserPromptSubmit" || params.eventName === "Stop") {
    return undefined;
  }
  return "*";
}

function buildAdapterCommand(params) {
  return [
    "node",
    shellQuote({ value: params.adapterPath }),
  ].join(" ");
}

function shellQuote(params) {
  return `'${params.value.replaceAll("'", "'\\''")}'`;
}

async function fileExists(params) {
  try {
    await fs.access(params.filePath);
    return true;
  } catch {
    return false;
  }
}

function createBackupPath(params) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const directory = path.dirname(params.hooksPath);
  return path.join(directory, `hooks.agent-office-backup-${stamp}.json`);
}

function expandHome(params) {
  if (params.value === "~") {
    return process.env.HOME ?? params.value;
  }
  if (params.value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", params.value.slice(2));
  }
  return params.value;
}

function isRecord(params) {
  return typeof params.value === "object" && params.value !== null && !Array.isArray(params.value);
}

function fail(params) {
  process.stderr.write(`${params.message}\n`);
  process.exit(1);
}
