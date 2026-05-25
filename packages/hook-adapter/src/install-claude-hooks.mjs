import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs({ argv: process.argv.slice(2) });

if (args.claudeHome === undefined) {
  fail({ message: "Missing --claude-home" });
}
if (args.adapter === undefined) {
  fail({ message: "Missing --adapter" });
}

const claudeHome = path.resolve(expandHome({ value: args.claudeHome }));
const adapterPath = path.resolve(args.adapter);
const settingsPath = path.join(claudeHome, "settings.json");

await assertDirectory({ directoryPath: claudeHome, label: "Claude home" });
await assertReadableFile({ filePath: adapterPath, label: "Claude hook adapter" });

const existingSettings = await readExistingSettings({ settingsPath });
const command = buildAdapterCommand({ adapterPath });
const nextSettings = mergeAgentOfficeHooks({ existingSettings, command, adapterPath });

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify(nextSettings, null, 2)}\n`);
  process.exit(0);
}

let backupPath;
if (await fileExists({ filePath: settingsPath })) {
  backupPath = createBackupPath({ settingsPath });
  await fs.copyFile(settingsPath, backupPath);
}

await fs.writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

if (backupPath === undefined) {
  process.stdout.write(`Wrote ${settingsPath}\n`);
} else {
  process.stdout.write(`Updated ${settingsPath}\nBackup: ${backupPath}\n`);
}
process.stdout.write("Claude Code will load these hooks on its next startup. Review them with /hooks.\n");

function parseArgs(params) {
  const parsed = { dryRun: false };
  for (let index = 0; index < params.argv.length; index += 1) {
    const current = params.argv[index];
    const next = params.argv[index + 1];
    if (current === "--claude-home" && next !== undefined) {
      parsed.claudeHome = next;
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

async function readExistingSettings(params) {
  if (!(await fileExists({ filePath: params.settingsPath }))) {
    return { hooks: {} };
  }

  let raw;
  try {
    raw = await fs.readFile(params.settingsPath, "utf8");
  } catch (error) {
    fail({ message: `Cannot read existing Claude settings at ${params.settingsPath}: ${error.message}` });
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail({ message: `Existing Claude settings file is not valid JSON: ${error.message}` });
  }

  if (!isRecord({ value })) {
    fail({ message: "Existing Claude settings file must be a JSON object" });
  }
  if (value.hooks !== undefined && !isRecord({ value: value.hooks })) {
    fail({ message: "Existing Claude settings field hooks must be an object" });
  }

  return {
    ...value,
    hooks: value.hooks ?? {},
  };
}

function mergeAgentOfficeHooks(params) {
  const next = structuredClone(params.existingSettings);
  next.hooks = isRecord({ value: next.hooks }) ? next.hooks : {};

  for (const eventName of hookEventsToInstall()) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    next.hooks[eventName] = appendHookGroup({
      groups: groups.filter((group) => !isAgentOfficeHookGroup({ group, adapterPath: params.adapterPath })),
      command: params.command,
    });
  }

  return next;
}

function hookEventsToInstall() {
  return [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "PreCompact",
  ];
}

function isAgentOfficeHookGroup(params) {
  if (!isRecord({ value: params.group }) || !Array.isArray(params.group.hooks)) {
    return false;
  }
  return params.group.hooks.some((hook) => {
    if (!isRecord({ value: hook }) || hook.type !== "command" || typeof hook.command !== "string") {
      return false;
    }
    return hook.command.includes(params.adapterPath)
      || hook.command.includes("packages/hook-adapter/src/claude-hook-adapter.mjs");
  });
}

function appendHookGroup(params) {
  const group = {
    hooks: [
      {
        type: "command",
        command: params.command,
        timeout: 5,
      },
    ],
  };
  return [...params.groups, group];
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
  const directory = path.dirname(params.settingsPath);
  return path.join(directory, `settings.agent-office-backup-${stamp}.json`);
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
