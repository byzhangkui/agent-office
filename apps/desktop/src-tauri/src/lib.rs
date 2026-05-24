use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

const CODEX_SOURCE_AGENT_ID: &str = "codex";
const CODEX_IDENTITY_KEY: &str = "codex";
const HOOK_HOST: &str = "127.0.0.1";
const HOOK_PORT: u16 = 47391;
const MAX_HOOK_BODY_BYTES: usize = 65_536;
const MAX_LOG_ITEMS: usize = 200;
const HOOK_EVENT_NAME: &str = "hook-event";
const HOOK_LOG_NAME: &str = "hook-log";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    id: String,
    agent_id: String,
    workspace: String,
    event: String,
    task_id: Option<String>,
    title: Option<String>,
    timestamp: String,
    details: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeLogItem {
    id: String,
    timestamp: String,
    level: String,
    source: String,
    message: String,
    status_code: Option<u16>,
    agent_id: Option<String>,
    event: Option<String>,
    workspace: Option<String>,
    details: Value,
}

struct HookServerState {
    token: String,
    events: Mutex<VecDeque<HookEvent>>,
    logs: Mutex<VecDeque<BridgeLogItem>>,
    next_log_id: AtomicU64,
}

impl HookServerState {
    fn new(token: String) -> Self {
        Self {
            token,
            events: Mutex::new(VecDeque::new()),
            logs: Mutex::new(VecDeque::new()),
            next_log_id: AtomicU64::new(1),
        }
    }
}

struct IncomingRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[tauri::command]
fn get_history(state: State<'_, Arc<HookServerState>>) -> Result<Vec<HookEvent>, String> {
    let events = state.events.lock().map_err(|_| "hook event history lock is poisoned".to_string())?;
    Ok(events.iter().cloned().collect())
}

#[tauri::command]
fn get_logs(state: State<'_, Arc<HookServerState>>) -> Result<Vec<BridgeLogItem>, String> {
    let logs = state.logs.lock().map_err(|_| "hook log lock is poisoned".to_string())?;
    Ok(logs.iter().cloned().collect())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let token = load_or_create_hook_token().map_err(to_boxed_error)?;
            let state = Arc::new(HookServerState::new(token));
            let listener = TcpListener::bind((HOOK_HOST, HOOK_PORT))
                .map_err(|error| format!("cannot bind Agent Office hook server on {HOOK_HOST}:{HOOK_PORT}: {error}"))
                .map_err(to_boxed_error)?;
            start_hook_server(app.handle().clone(), Arc::clone(&state), listener);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_history, get_logs])
        .run(tauri::generate_context!())
        .expect("failed to run Agent Office");
}

fn start_hook_server(app: AppHandle, state: Arc<HookServerState>, listener: TcpListener) {
    append_and_emit_log(
        &app,
        &state,
        LogInput {
            level: "info",
            source: "hook-server",
            message: "Agent Office hook server started",
            status_code: Some(200),
            event: None,
            details: json!({ "host": HOOK_HOST, "port": HOOK_PORT }),
        },
    );

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    let state = Arc::clone(&state);
                    thread::spawn(move || handle_connection(app, state, stream));
                }
                Err(error) => {
                    append_and_emit_log(
                        &app,
                        &state,
                        LogInput {
                            level: "error",
                            source: "hook-server",
                            message: "failed to accept hook server connection",
                            status_code: None,
                            event: None,
                            details: json!({ "error": error.to_string() }),
                        },
                    );
                }
            }
        }
    });
}

fn handle_connection(app: AppHandle, state: Arc<HookServerState>, mut stream: TcpStream) {
    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_json_response(&mut stream, error.status, json!({ "ok": false, "error": error.message }));
            return;
        }
    };

    if request.method == "GET" && request.path == "/health" {
        let _ = write_json_response(&mut stream, 200, json!({ "ok": true }));
        return;
    }

    if !is_authorized(&state, &request) {
        append_and_emit_log(
            &app,
            &state,
            LogInput {
                level: "warn",
                source: "hook",
                message: "hook request rejected: missing or invalid token",
                status_code: Some(401),
                event: None,
                details: json!({ "path": request.path }),
            },
        );
        let _ = write_json_response(&mut stream, 401, json!({ "ok": false, "error": "missing or invalid Agent Office hook token" }));
        return;
    }

    if request.method == "GET" && request.path == "/logs" {
        let logs = match state.logs.lock() {
            Ok(logs) => logs.iter().cloned().collect::<Vec<_>>(),
            Err(_) => {
                let _ = write_json_response(&mut stream, 500, json!({ "ok": false, "error": "hook log lock is poisoned" }));
                return;
            }
        };
        let _ = write_json_response(&mut stream, 200, json!({ "ok": true, "logs": logs }));
        return;
    }

    if request.method == "GET" && request.path == "/history" {
        let events = match state.events.lock() {
            Ok(events) => events.iter().cloned().collect::<Vec<_>>(),
            Err(_) => {
                let _ = write_json_response(&mut stream, 500, json!({ "ok": false, "error": "hook event history lock is poisoned" }));
                return;
            }
        };
        let _ = write_json_response(&mut stream, 200, json!({ "ok": true, "events": events }));
        return;
    }

    if request.method == "POST" && request.path == "/hook" {
        handle_hook_post(&app, &state, &request, &mut stream);
        return;
    }

    append_and_emit_log(
        &app,
        &state,
        LogInput {
            level: "warn",
            source: "hook-server",
            message: "route not found",
            status_code: Some(404),
            event: None,
            details: json!({ "method": request.method, "path": request.path }),
        },
    );
    let _ = write_json_response(&mut stream, 404, json!({ "ok": false, "error": "route not found" }));
}

fn handle_hook_post(app: &AppHandle, state: &Arc<HookServerState>, request: &IncomingRequest, stream: &mut TcpStream) {
    let event = match serde_json::from_slice::<HookEvent>(&request.body) {
        Ok(event) => event,
        Err(error) => {
            append_and_emit_log(
                app,
                state,
                LogInput {
                    level: "error",
                    source: "hook",
                    message: "hook payload is not valid JSON",
                    status_code: Some(400),
                    event: None,
                    details: json!({ "error": error.to_string() }),
                },
            );
            let _ = write_json_response(stream, 400, json!({ "ok": false, "error": "hook payload is not valid JSON" }));
            return;
        }
    };

    if let Err(error) = validate_hook_event(&event) {
        append_and_emit_log(
            app,
            state,
            LogInput {
                level: "warn",
                source: "hook",
                message: &error,
                status_code: Some(422),
                event: Some(&event),
                details: json!({}),
            },
        );
        let _ = write_json_response(stream, 422, json!({ "ok": false, "error": error }));
        return;
    }

    {
        let mut events = match state.events.lock() {
            Ok(events) => events,
            Err(_) => {
                let _ = write_json_response(stream, 500, json!({ "ok": false, "error": "hook event history lock is poisoned" }));
                return;
            }
        };
        events.push_back(event.clone());
        while events.len() > MAX_LOG_ITEMS {
            events.pop_front();
        }
    }

    let _ = app.emit(HOOK_EVENT_NAME, &event);
    append_and_emit_log(
        app,
        state,
        LogInput {
            level: "info",
            source: "hook",
            message: "hook event accepted and broadcast",
            status_code: Some(202),
            event: Some(&event),
            details: json!({}),
        },
    );
    let _ = write_json_response(stream, 202, json!({ "ok": true }));
}

fn validate_hook_event(event: &HookEvent) -> Result<(), String> {
    if event.id.trim().is_empty() {
        return Err("hook event id is required".to_string());
    }
    if event.agent_id.trim().is_empty() {
        return Err("hook event agentId is required".to_string());
    }
    if event.workspace.trim().is_empty() {
        return Err("hook event workspace is required".to_string());
    }
    if !matches!(
        event.event.as_str(),
        "task_started" | "task_completed" | "task_failed" | "task_blocked" | "user_input_required" | "agent_idle"
    ) {
        return Err("hook event name is not supported".to_string());
    }
    if DateTime::parse_from_rfc3339(&event.timestamp).is_err() {
        return Err("hook event timestamp must be RFC3339".to_string());
    }
    if !event.details.is_object() {
        return Err("hook event details must be an object".to_string());
    }
    if !is_valid_codex_session_agent(event) {
        return Err("agentId is not a valid Codex session agent".to_string());
    }
    Ok(())
}

fn is_valid_codex_session_agent(event: &HookEvent) -> bool {
    let Some(details) = event.details.as_object() else {
        return false;
    };
    let Some(source_agent_id) = details.get("codexSourceAgentId").and_then(Value::as_str) else {
        return false;
    };
    let Some(session_id) = details.get("codexSessionId").and_then(Value::as_str) else {
        return false;
    };
    let Some(identity_key) = details.get("codexIdentityKey").and_then(Value::as_str) else {
        return false;
    };
    if source_agent_id != CODEX_SOURCE_AGENT_ID || identity_key != CODEX_IDENTITY_KEY {
        return false;
    }

    event.agent_id == create_session_agent_id(source_agent_id, session_id, identity_key)
}

fn create_session_agent_id(source_agent_id: &str, session_id: &str, identity_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{source_agent_id}\n{session_id}\n{identity_key}"));
    let digest = hasher.finalize();
    format!("{source_agent_id}-session-{}", hex_encode_prefix(&digest, 10))
}

struct LogInput<'a> {
    level: &'a str,
    source: &'a str,
    message: &'a str,
    status_code: Option<u16>,
    event: Option<&'a HookEvent>,
    details: Value,
}

fn append_and_emit_log(app: &AppHandle, state: &Arc<HookServerState>, input: LogInput<'_>) {
    let log = BridgeLogItem {
        id: format!("{}-{}", Utc::now().timestamp_millis(), state.next_log_id.fetch_add(1, Ordering::Relaxed)),
        timestamp: now_iso(),
        level: input.level.to_string(),
        source: input.source.to_string(),
        message: input.message.to_string(),
        status_code: input.status_code,
        agent_id: input.event.map(|event| event.agent_id.clone()),
        event: input.event.map(|event| event.event.clone()),
        workspace: input.event.map(|event| event.workspace.clone()),
        details: merge_log_details(input.event, input.details),
    };

    if let Ok(mut logs) = state.logs.lock() {
        logs.push_front(log.clone());
        while logs.len() > MAX_LOG_ITEMS {
            logs.pop_back();
        }
    }
    let _ = app.emit(HOOK_LOG_NAME, &log);
}

fn merge_log_details(event: Option<&HookEvent>, details: Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Some(event) = event {
        if let Some(title) = &event.title {
            merged.insert("title".to_string(), json!(title));
        }
        if let Some(task_id) = &event.task_id {
            merged.insert("taskId".to_string(), json!(task_id));
        }
        merged.insert("hookDetails".to_string(), event.details.clone());
    }
    if let Some(object) = details.as_object() {
        for (key, value) in object {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn is_authorized(state: &HookServerState, request: &IncomingRequest) -> bool {
    let Some(header) = request.headers.get("authorization") else {
        return false;
    };
    header == &format!("Bearer {}", state.token)
}

struct HttpReadError {
    status: u16,
    message: String,
}

fn read_http_request(stream: &mut TcpStream) -> Result<IncomingRequest, HttpReadError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| HttpReadError { status: 500, message: error.to_string() })?;

    let mut bytes = Vec::new();
    let mut header_end = None;
    let mut content_length = 0usize;
    let mut buffer = [0u8; 4096];

    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| HttpReadError { status: 400, message: error.to_string() })?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);

        if header_end.is_none() {
            if let Some(end) = find_header_end(&bytes) {
                header_end = Some(end);
                let header_text = std::str::from_utf8(&bytes[..end])
                    .map_err(|_| HttpReadError { status: 400, message: "request header is not UTF-8".to_string() })?;
                content_length = parse_content_length(header_text)?;
                if content_length > MAX_HOOK_BODY_BYTES {
                    return Err(HttpReadError { status: 413, message: "request body exceeds maxHookBodyBytes".to_string() });
                }
            }
        }

        if let Some(end) = header_end {
            if bytes.len() >= end + content_length {
                break;
            }
        }

        if bytes.len() > MAX_HOOK_BODY_BYTES + 8192 {
            return Err(HttpReadError { status: 413, message: "request body exceeds maxHookBodyBytes".to_string() });
        }
    }

    let Some(end) = header_end else {
        return Err(HttpReadError { status: 400, message: "request is missing HTTP headers".to_string() });
    };

    let header_text = std::str::from_utf8(&bytes[..end])
        .map_err(|_| HttpReadError { status: 400, message: "request header is not UTF-8".to_string() })?;
    let (method, path, headers) = parse_headers(header_text)?;
    let body_end = end + content_length;
    if bytes.len() < body_end {
        return Err(HttpReadError { status: 400, message: "request body is incomplete".to_string() });
    }

    Ok(IncomingRequest {
        method,
        path,
        headers,
        body: bytes[end..body_end].to_vec(),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
}

fn parse_content_length(header_text: &str) -> Result<usize, HttpReadError> {
    let (_, _, headers) = parse_headers(header_text)?;
    match headers.get("content-length") {
        Some(value) => value.parse::<usize>().map_err(|_| HttpReadError {
            status: 400,
            message: "Content-Length header is invalid".to_string(),
        }),
        None => Ok(0),
    }
}

fn parse_headers(header_text: &str) -> Result<(String, String, HashMap<String, String>), HttpReadError> {
    let mut lines = header_text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return Err(HttpReadError { status: 400, message: "request line is missing".to_string() });
    };
    let mut request_parts = request_line.split_whitespace();
    let Some(method) = request_parts.next() else {
        return Err(HttpReadError { status: 400, message: "request method is missing".to_string() });
    };
    let Some(path) = request_parts.next() else {
        return Err(HttpReadError { status: 400, message: "request path is missing".to_string() });
    };

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    Ok((method.to_string(), path.to_string(), headers))
}

fn write_json_response(stream: &mut TcpStream, status: u16, body: Value) -> std::io::Result<()> {
    let reason = reason_phrase(status);
    let body_text = body.to_string();
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: http://127.0.0.1:1420\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body_text.as_bytes().len(),
        body_text
    );
    stream.write_all(response.as_bytes())
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

fn load_or_create_hook_token() -> Result<String, String> {
    let token_path = hook_token_path()?;
    if token_path.exists() {
        let token = fs::read_to_string(&token_path)
            .map_err(|error| format!("cannot read hook token at {}: {error}", token_path.display()))?;
        let trimmed = token.trim().to_string();
        if trimmed.is_empty() {
            return Err(format!("hook token at {} is empty", token_path.display()));
        }
        return Ok(trimmed);
    }

    let parent = token_path
        .parent()
        .ok_or_else(|| format!("hook token path has no parent: {}", token_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create Agent Office state directory at {}: {error}", parent.display()))?;

    let token = generate_token()?;
    fs::write(&token_path, format!("{token}\n"))
        .map_err(|error| format!("cannot write hook token at {}: {error}", token_path.display()))?;
    restrict_token_permissions(&token_path)?;
    Ok(token)
}

fn hook_token_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is required to locate Agent Office hook token".to_string())?;
    Ok(PathBuf::from(home).join(".agent-office").join("hook-token"))
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("cannot generate hook token: {error}"))?;
    Ok(hex_encode(&bytes))
}

#[cfg(unix)]
fn restrict_token_permissions(path: &PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("cannot read hook token metadata at {}: {error}", path.display()))?
        .permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("cannot set hook token permissions at {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn restrict_token_permissions(_path: &PathBuf) -> Result<(), String> {
    Ok(())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn hex_encode_prefix(bytes: &[u8], chars: usize) -> String {
    let encoded = hex_encode(bytes);
    encoded.chars().take(chars).collect()
}

fn to_boxed_error(message: String) -> Box<dyn std::error::Error> {
    std::io::Error::new(std::io::ErrorKind::Other, message).into()
}
