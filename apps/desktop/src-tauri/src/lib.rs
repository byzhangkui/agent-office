use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Rect, State, WebviewWindow, WindowEvent,
};
use toml_edit::{value as toml_value, DocumentMut, Item, Table};

// Known real agent sources, each paired with the identity key its adapter
// signs session agents with. A hook event is accepted only if its identity
// envelope matches one of these pairs.
const KNOWN_AGENT_SOURCES: &[(&str, &str)] = &[("codex", "codex"), ("claude", "claude")];
const HOOK_HOST: &str = "127.0.0.1";
const HOOK_PORT: u16 = 47391;
const MAX_HOOK_BODY_BYTES: usize = 65_536;
const MAX_LOG_ITEMS: usize = 200;
const HOOK_EVENT_NAME: &str = "hook-event";
const HOOK_LOG_NAME: &str = "hook-log";
const SETTINGS_EVENT_NAME: &str = "open-settings";
const TRAY_ID: &str = "agent-office";
const TRAY_MENU_SHOW_ID: &str = "show";
const TRAY_MENU_SETTINGS_ID: &str = "settings";
const TRAY_MENU_QUIT_ID: &str = "quit";
const POPOVER_MARGIN: f64 = 8.0;
const AUTO_HIDE_DELAY_MS: u64 = 120;
const CODEX_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
];

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexHookSettings {
    codex_home: String,
    config_path: String,
    hooks_path: String,
    adapter_path: String,
    error_log_path: String,
    adapter_exists: bool,
    config_exists: bool,
    hooks_file_exists: bool,
    hooks_enabled: bool,
    plugin_hooks_enabled: bool,
    registered_events: Vec<String>,
    missing_events: Vec<String>,
    installed: bool,
    restart_required: bool,
    last_error_log: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexHookOperationResult {
    settings: CodexHookSettings,
    message: String,
}

#[derive(Debug, Clone)]
struct CodexHookPaths {
    codex_home: PathBuf,
    config_path: PathBuf,
    hooks_path: PathBuf,
    adapter_path: PathBuf,
    error_log_path: PathBuf,
}

#[derive(Debug, Clone)]
struct CodexHookFeatures {
    hooks_enabled: bool,
    plugin_hooks_enabled: bool,
}

#[tauri::command]
fn get_history(state: State<'_, Arc<HookServerState>>) -> Result<Vec<HookEvent>, String> {
    let events = state
        .events
        .lock()
        .map_err(|_| "hook event history lock is poisoned".to_string())?;
    Ok(events.iter().cloned().collect())
}

#[tauri::command]
fn get_logs(state: State<'_, Arc<HookServerState>>) -> Result<Vec<BridgeLogItem>, String> {
    let logs = state
        .logs
        .lock()
        .map_err(|_| "hook log lock is poisoned".to_string())?;
    Ok(logs.iter().cloned().collect())
}

#[tauri::command]
fn get_codex_hook_settings() -> Result<CodexHookSettings, String> {
    inspect_codex_hook_settings()
}

#[tauri::command]
fn register_codex_hooks() -> Result<CodexHookOperationResult, String> {
    install_agent_office_codex_hooks()?;
    Ok(CodexHookOperationResult {
        settings: inspect_codex_hook_settings()?,
        message: "Codex hooks 已注册，重启 Codex 后生效".to_string(),
    })
}

#[tauri::command]
fn unregister_codex_hooks() -> Result<CodexHookOperationResult, String> {
    remove_agent_office_codex_hooks()?;
    Ok(CodexHookOperationResult {
        settings: inspect_codex_hook_settings()?,
        message: "Agent Office hooks 已取消注册".to_string(),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_status_bar(app.handle()).map_err(to_boxed_error)?;
            setup_close_to_hide(app.handle());
            let token = load_or_create_hook_token().map_err(to_boxed_error)?;
            let state = Arc::new(HookServerState::new(token));
            let listener = TcpListener::bind((HOOK_HOST, HOOK_PORT))
                .map_err(|error| {
                    format!(
                        "cannot bind Agent Office hook server on {HOOK_HOST}:{HOOK_PORT}: {error}"
                    )
                })
                .map_err(to_boxed_error)?;
            start_hook_server(app.handle().clone(), Arc::clone(&state), listener);
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            get_logs,
            get_codex_hook_settings,
            register_codex_hooks,
            unregister_codex_hooks
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Agent Office");
}

fn setup_status_bar(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(
        app,
        TRAY_MENU_SHOW_ID,
        "打开 Agent Office",
        true,
        None::<&str>,
    )
    .map_err(|error| format!("cannot create tray show menu item: {error}"))?;
    let settings_item =
        MenuItem::with_id(app, TRAY_MENU_SETTINGS_ID, "设置", true, None::<&str>)
            .map_err(|error| format!("cannot create tray settings menu item: {error}"))?;
    let separator = PredefinedMenuItem::separator(app)
        .map_err(|error| format!("cannot create tray menu separator: {error}"))?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "退出", true, None::<&str>)
        .map_err(|error| format!("cannot create tray quit menu item: {error}"))?;
    let menu = Menu::with_items(app, &[&show_item, &settings_item, &separator, &quit_item])
        .map_err(|error| format!("cannot create tray menu: {error}"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(create_tray_template_icon())
        .icon_as_template(true)
        .tooltip("Agent Office")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW_ID => show_main_window(app),
            TRAY_MENU_SETTINGS_ID => open_settings_window(app),
            TRAY_MENU_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } => {
                toggle_main_window_from_tray(tray.app_handle(), rect);
            }
            _ => {}
        })
        .build(app)
        .map_err(|error| format!("cannot build tray icon: {error}"))?;
    Ok(())
}

fn create_tray_template_icon() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    draw_rect(&mut rgba, SIZE, 4, 4, 24, 3);
    draw_rect(&mut rgba, SIZE, 4, 4, 3, 19);
    draw_rect(&mut rgba, SIZE, 25, 4, 3, 19);
    draw_rect(&mut rgba, SIZE, 4, 20, 24, 3);
    draw_rect(&mut rgba, SIZE, 8, 8, 6, 4);
    draw_rect(&mut rgba, SIZE, 17, 8, 8, 3);
    draw_rect(&mut rgba, SIZE, 17, 14, 8, 3);
    draw_rect(&mut rgba, SIZE, 8, 18, 16, 3);
    draw_rect(&mut rgba, SIZE, 15, 23, 3, 4);
    draw_rect(&mut rgba, SIZE, 10, 27, 13, 3);
    Image::new_owned(rgba, SIZE, SIZE)
}

fn draw_rect(rgba: &mut [u8], canvas_width: u32, x: u32, y: u32, width: u32, height: u32) {
    for row in y..y + height {
        for column in x..x + width {
            let index = ((row * canvas_width + column) * 4) as usize;
            rgba[index] = 0;
            rgba[index + 1] = 0;
            rgba[index + 2] = 0;
            rgba[index + 3] = 255;
        }
    }
}

fn setup_close_to_hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let window_to_hide = window.clone();
        let window_to_auto_hide = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window_to_hide.hide();
            }
            WindowEvent::Focused(false) => {
                let window = window_to_auto_hide.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(AUTO_HIDE_DELAY_MS));
                    if matches!(window.is_visible(), Ok(true))
                        && !matches!(window.is_focused(), Ok(true))
                    {
                        let _ = window.hide();
                    }
                });
            }
            _ => {}
        });
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show_floating_window(&window);
    }
}

fn open_settings_window(app: &AppHandle) {
    show_main_window(app);
    let _ = app.emit(SETTINGS_EVENT_NAME, json!({}));
}

fn toggle_main_window_from_tray(app: &AppHandle, tray_rect: Rect) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if matches!(window.is_visible(), Ok(true)) {
        let _ = window.hide();
        return;
    }

    let _ = position_window_near_tray(&window, tray_rect);
    show_floating_window(&window);
}

fn show_floating_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn position_window_near_tray(window: &WebviewWindow, tray_rect: Rect) -> Result<(), String> {
    let tray_position = tray_rect.position.to_physical::<f64>(1.0);
    let tray_size = tray_rect.size.to_physical::<f64>(1.0);
    let window_size = window
        .outer_size()
        .or_else(|_| window.inner_size())
        .map_err(|error| format!("cannot read Agent Office window size: {error}"))?;
    let monitor = window
        .monitor_from_point(tray_position.x, tray_position.y)
        .map_err(|error| format!("cannot read monitor at tray position: {error}"))?
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let work_x = f64::from(work_area.position.x);
    let work_y = f64::from(work_area.position.y);
    let work_width = f64::from(work_area.size.width);
    let work_height = f64::from(work_area.size.height);
    let window_width = f64::from(window_size.width);
    let window_height = f64::from(window_size.height);
    let tray_center_x = tray_position.x + tray_size.width / 2.0;

    let max_x = work_x + (work_width - window_width).max(0.0);
    let max_y = work_y + (work_height - window_height).max(0.0);
    let x = (tray_center_x - window_width / 2.0).clamp(work_x, max_x);
    let below_tray_y = tray_position.y + tray_size.height + POPOVER_MARGIN;
    let above_tray_y = tray_position.y - window_height - POPOVER_MARGIN;
    let y = if below_tray_y + window_height <= work_y + work_height {
        below_tray_y.max(work_y)
    } else {
        above_tray_y.clamp(work_y, max_y)
    };

    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| format!("cannot position Agent Office window: {error}"))
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
            let _ = write_json_response(
                &mut stream,
                error.status,
                json!({ "ok": false, "error": error.message }),
            );
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
        let _ = write_json_response(
            &mut stream,
            401,
            json!({ "ok": false, "error": "missing or invalid Agent Office hook token" }),
        );
        return;
    }

    if request.method == "GET" && request.path == "/logs" {
        let logs = match state.logs.lock() {
            Ok(logs) => logs.iter().cloned().collect::<Vec<_>>(),
            Err(_) => {
                let _ = write_json_response(
                    &mut stream,
                    500,
                    json!({ "ok": false, "error": "hook log lock is poisoned" }),
                );
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
                let _ = write_json_response(
                    &mut stream,
                    500,
                    json!({ "ok": false, "error": "hook event history lock is poisoned" }),
                );
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
    let _ = write_json_response(
        &mut stream,
        404,
        json!({ "ok": false, "error": "route not found" }),
    );
}

fn handle_hook_post(
    app: &AppHandle,
    state: &Arc<HookServerState>,
    request: &IncomingRequest,
    stream: &mut TcpStream,
) {
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
            let _ = write_json_response(
                stream,
                400,
                json!({ "ok": false, "error": "hook payload is not valid JSON" }),
            );
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
                let _ = write_json_response(
                    stream,
                    500,
                    json!({ "ok": false, "error": "hook event history lock is poisoned" }),
                );
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
        "task_started"
            | "task_completed"
            | "task_failed"
            | "task_blocked"
            | "user_input_required"
            | "agent_idle"
    ) {
        return Err("hook event name is not supported".to_string());
    }
    if DateTime::parse_from_rfc3339(&event.timestamp).is_err() {
        return Err("hook event timestamp must be RFC3339".to_string());
    }
    if !event.details.is_object() {
        return Err("hook event details must be an object".to_string());
    }
    if !is_valid_session_agent(event) {
        return Err("agentId is not a valid agent session identity".to_string());
    }
    Ok(())
}

fn is_valid_session_agent(event: &HookEvent) -> bool {
    let Some(details) = event.details.as_object() else {
        return false;
    };
    let Some(source_agent_id) = details.get("agentSourceId").and_then(Value::as_str) else {
        return false;
    };
    let Some(session_id) = details.get("agentSessionId").and_then(Value::as_str) else {
        return false;
    };
    let Some(identity_key) = details.get("agentIdentityKey").and_then(Value::as_str) else {
        return false;
    };
    let is_known_source = KNOWN_AGENT_SOURCES
        .iter()
        .any(|(source, identity)| *source == source_agent_id && *identity == identity_key);
    if !is_known_source {
        return false;
    }

    event.agent_id == create_session_agent_id(source_agent_id, session_id, identity_key)
}

fn create_session_agent_id(source_agent_id: &str, session_id: &str, identity_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{source_agent_id}\n{session_id}\n{identity_key}"));
    let digest = hasher.finalize();
    format!(
        "{source_agent_id}-session-{}",
        hex_encode_prefix(&digest, 10)
    )
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
        id: format!(
            "{}-{}",
            Utc::now().timestamp_millis(),
            state.next_log_id.fetch_add(1, Ordering::Relaxed)
        ),
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
        .map_err(|error| HttpReadError {
            status: 500,
            message: error.to_string(),
        })?;

    let mut bytes = Vec::new();
    let mut header_end = None;
    let mut content_length = 0usize;
    let mut buffer = [0u8; 4096];

    loop {
        let read = stream.read(&mut buffer).map_err(|error| HttpReadError {
            status: 400,
            message: error.to_string(),
        })?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);

        if header_end.is_none() {
            if let Some(end) = find_header_end(&bytes) {
                header_end = Some(end);
                let header_text =
                    std::str::from_utf8(&bytes[..end]).map_err(|_| HttpReadError {
                        status: 400,
                        message: "request header is not UTF-8".to_string(),
                    })?;
                content_length = parse_content_length(header_text)?;
                if content_length > MAX_HOOK_BODY_BYTES {
                    return Err(HttpReadError {
                        status: 413,
                        message: "request body exceeds maxHookBodyBytes".to_string(),
                    });
                }
            }
        }

        if let Some(end) = header_end {
            if bytes.len() >= end + content_length {
                break;
            }
        }

        if bytes.len() > MAX_HOOK_BODY_BYTES + 8192 {
            return Err(HttpReadError {
                status: 413,
                message: "request body exceeds maxHookBodyBytes".to_string(),
            });
        }
    }

    let Some(end) = header_end else {
        return Err(HttpReadError {
            status: 400,
            message: "request is missing HTTP headers".to_string(),
        });
    };

    let header_text = std::str::from_utf8(&bytes[..end]).map_err(|_| HttpReadError {
        status: 400,
        message: "request header is not UTF-8".to_string(),
    })?;
    let (method, path, headers) = parse_headers(header_text)?;
    let body_end = end + content_length;
    if bytes.len() < body_end {
        return Err(HttpReadError {
            status: 400,
            message: "request body is incomplete".to_string(),
        });
    }

    Ok(IncomingRequest {
        method,
        path,
        headers,
        body: bytes[end..body_end].to_vec(),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
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

fn parse_headers(
    header_text: &str,
) -> Result<(String, String, HashMap<String, String>), HttpReadError> {
    let mut lines = header_text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return Err(HttpReadError {
            status: 400,
            message: "request line is missing".to_string(),
        });
    };
    let mut request_parts = request_line.split_whitespace();
    let Some(method) = request_parts.next() else {
        return Err(HttpReadError {
            status: 400,
            message: "request method is missing".to_string(),
        });
    };
    let Some(path) = request_parts.next() else {
        return Err(HttpReadError {
            status: 400,
            message: "request path is missing".to_string(),
        });
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

fn inspect_codex_hook_settings() -> Result<CodexHookSettings, String> {
    let paths = resolve_codex_hook_paths()?;
    let features = read_codex_hook_features(&paths.config_path)?;
    let hooks_file_exists = paths.hooks_path.exists();
    let hooks = read_hooks_json_or_empty(&paths.hooks_path)?;
    let registered_events = registered_agent_office_events(&hooks, &paths.adapter_path);
    let missing_events = CODEX_HOOK_EVENTS
        .iter()
        .filter(|event_name| {
            !registered_events
                .iter()
                .any(|registered| registered == *event_name)
        })
        .map(|event_name| (*event_name).to_string())
        .collect::<Vec<_>>();
    let adapter_exists = paths.adapter_path.is_file();
    let config_exists = paths.config_path.is_file();
    let installed =
        adapter_exists && config_exists && features.hooks_enabled && missing_events.is_empty();

    Ok(CodexHookSettings {
        codex_home: path_to_string(&paths.codex_home),
        config_path: path_to_string(&paths.config_path),
        hooks_path: path_to_string(&paths.hooks_path),
        adapter_path: path_to_string(&paths.adapter_path),
        error_log_path: path_to_string(&paths.error_log_path),
        adapter_exists,
        config_exists,
        hooks_file_exists,
        hooks_enabled: features.hooks_enabled,
        plugin_hooks_enabled: features.plugin_hooks_enabled,
        registered_events,
        missing_events,
        installed,
        restart_required: true,
        last_error_log: read_text_tail(&paths.error_log_path, 16)?,
    })
}

fn install_agent_office_codex_hooks() -> Result<(), String> {
    let paths = resolve_codex_hook_paths()?;
    if !paths.config_path.is_file() {
        return Err(format!(
            "Codex config is missing at {}",
            paths.config_path.display()
        ));
    }
    if !paths.adapter_path.is_file() {
        return Err(format!(
            "Codex hook adapter is missing at {}",
            paths.adapter_path.display()
        ));
    }

    let mut hooks = read_hooks_json_or_empty(&paths.hooks_path)?;
    merge_agent_office_hooks(&mut hooks, &paths.adapter_path)?;
    write_hooks_json_with_backup(&paths.hooks_path, &hooks)?;
    enable_codex_hook_features(&paths.config_path)?;
    Ok(())
}

fn remove_agent_office_codex_hooks() -> Result<(), String> {
    let paths = resolve_codex_hook_paths()?;
    if !paths.hooks_path.exists() {
        return Ok(());
    }

    let mut hooks = read_hooks_json_or_empty(&paths.hooks_path)?;
    remove_agent_office_hook_entries(&mut hooks, &paths.adapter_path)?;
    write_hooks_json_with_backup(&paths.hooks_path, &hooks)?;
    Ok(())
}

fn resolve_codex_hook_paths() -> Result<CodexHookPaths, String> {
    let home =
        env::var_os("HOME").ok_or_else(|| "HOME is required to locate Codex hooks".to_string())?;
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".codex"));
    let config_path = codex_home.join("config.toml");
    let hooks_path = codex_home.join("hooks.json");
    let adapter_path = resolve_adapter_path();
    let error_log_path = agent_office_state_dir()?
        .join("logs")
        .join("hook-errors.log");

    Ok(CodexHookPaths {
        codex_home,
        config_path,
        hooks_path,
        adapter_path,
        error_log_path,
    })
}

fn resolve_adapter_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("packages")
        .join("hook-adapter")
        .join("src")
        .join("codex-hook-adapter.mjs");
    candidate.canonicalize().unwrap_or(candidate)
}

fn read_codex_hook_features(config_path: &Path) -> Result<CodexHookFeatures, String> {
    if !config_path.exists() {
        return Ok(CodexHookFeatures {
            hooks_enabled: false,
            plugin_hooks_enabled: false,
        });
    }

    let text = fs::read_to_string(config_path).map_err(|error| {
        format!(
            "cannot read Codex config at {}: {error}",
            config_path.display()
        )
    })?;
    let doc = text.parse::<DocumentMut>().map_err(|error| {
        format!(
            "cannot parse Codex config at {}: {error}",
            config_path.display()
        )
    })?;
    let features = doc.get("features").and_then(|item| item.as_table());

    Ok(CodexHookFeatures {
        hooks_enabled: features
            .and_then(|table| table.get("hooks"))
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
        plugin_hooks_enabled: features
            .and_then(|table| table.get("plugin_hooks"))
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
    })
}

fn enable_codex_hook_features(config_path: &Path) -> Result<(), String> {
    let original = fs::read_to_string(config_path).map_err(|error| {
        format!(
            "cannot read Codex config at {}: {error}",
            config_path.display()
        )
    })?;
    let mut doc = original.parse::<DocumentMut>().map_err(|error| {
        format!(
            "cannot parse Codex config at {}: {error}",
            config_path.display()
        )
    })?;
    let mut changed = false;

    if !doc.as_table().contains_key("features") || !doc["features"].is_table() {
        doc["features"] = Item::Table(Table::new());
        changed = true;
    }

    let features = doc["features"]
        .as_table_mut()
        .ok_or_else(|| "Codex config [features] section is not a table".to_string())?;
    for key in ["hooks", "plugin_hooks"] {
        if features.get(key).and_then(|item| item.as_bool()) != Some(true) {
            features[key] = toml_value(true);
            changed = true;
        }
    }

    if changed {
        backup_file_if_exists(config_path)?;
        fs::write(config_path, doc.to_string()).map_err(|error| {
            format!(
                "cannot write Codex config at {}: {error}",
                config_path.display()
            )
        })?;
    }
    Ok(())
}

fn read_hooks_json_or_empty(hooks_path: &Path) -> Result<Value, String> {
    if !hooks_path.exists() {
        return Ok(json!({ "hooks": {} }));
    }

    let text = fs::read_to_string(hooks_path).map_err(|error| {
        format!(
            "cannot read Codex hooks at {}: {error}",
            hooks_path.display()
        )
    })?;
    let value: Value = serde_json::from_str(&text).map_err(|error| {
        format!(
            "cannot parse Codex hooks at {}: {error}",
            hooks_path.display()
        )
    })?;
    if !value.is_object() {
        return Err(format!(
            "Codex hooks at {} must be a JSON object",
            hooks_path.display()
        ));
    }
    Ok(value)
}

fn write_hooks_json_with_backup(hooks_path: &Path, hooks: &Value) -> Result<(), String> {
    if let Some(parent) = hooks_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "cannot create Codex hooks directory at {}: {error}",
                parent.display()
            )
        })?;
    }
    backup_file_if_exists(hooks_path)?;
    let text = serde_json::to_string_pretty(hooks)
        .map_err(|error| format!("cannot serialize Codex hooks: {error}"))?;
    fs::write(hooks_path, format!("{text}\n")).map_err(|error| {
        format!(
            "cannot write Codex hooks at {}: {error}",
            hooks_path.display()
        )
    })
}

fn merge_agent_office_hooks(hooks: &mut Value, adapter_path: &Path) -> Result<(), String> {
    let command = build_adapter_command(adapter_path);
    let hooks_object = ensure_hooks_object(hooks)?;

    for event_name in CODEX_HOOK_EVENTS {
        let entries_value = hooks_object
            .entry((*event_name).to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let mut entries = entries_value.as_array().cloned().unwrap_or_default();
        entries.retain(|entry| !is_agent_office_hook_entry(entry, adapter_path));
        if !entries
            .iter()
            .any(|entry| has_exact_agent_office_command(entry, &command))
        {
            entries.push(build_agent_office_hook_entry(event_name, &command));
        }
        *entries_value = Value::Array(entries);
    }

    Ok(())
}

fn remove_agent_office_hook_entries(hooks: &mut Value, adapter_path: &Path) -> Result<(), String> {
    let hooks_object = ensure_hooks_object(hooks)?;
    let event_names = hooks_object.keys().cloned().collect::<Vec<_>>();
    for event_name in event_names {
        let Some(entries_value) = hooks_object.get_mut(&event_name) else {
            continue;
        };
        let Some(entries) = entries_value.as_array_mut() else {
            continue;
        };
        entries.retain(|entry| !is_agent_office_hook_entry(entry, adapter_path));
        if entries.is_empty() {
            hooks_object.remove(&event_name);
        }
    }
    Ok(())
}

fn ensure_hooks_object(hooks: &mut Value) -> Result<&mut serde_json::Map<String, Value>, String> {
    let object = hooks
        .as_object_mut()
        .ok_or_else(|| "Codex hooks must be a JSON object".to_string())?;
    let hooks_value = object
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks_value.is_object() {
        *hooks_value = json!({});
    }
    hooks_value
        .as_object_mut()
        .ok_or_else(|| "Codex hooks field must be an object".to_string())
}

fn registered_agent_office_events(hooks: &Value, adapter_path: &Path) -> Vec<String> {
    let Some(hooks_object) = hooks.get("hooks").and_then(|value| value.as_object()) else {
        return Vec::new();
    };

    CODEX_HOOK_EVENTS
        .iter()
        .filter(|event_name| {
            hooks_object
                .get(**event_name)
                .and_then(|value| value.as_array())
                .is_some_and(|entries| {
                    entries
                        .iter()
                        .any(|entry| is_agent_office_hook_entry(entry, adapter_path))
                })
        })
        .map(|event_name| (*event_name).to_string())
        .collect()
}

fn build_agent_office_hook_entry(event_name: &str, command: &str) -> Value {
    let mut entry = json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                "timeout": 2,
                "statusMessage": "notify Agent Office"
            }
        ]
    });
    if let Some(matcher) = matcher_for_event(event_name) {
        entry["matcher"] = json!(matcher);
    }
    entry
}

fn matcher_for_event(event_name: &str) -> Option<&'static str> {
    match event_name {
        "UserPromptSubmit" | "Stop" => None,
        _ => Some("*"),
    }
}

fn is_agent_office_hook_entry(entry: &Value, adapter_path: &Path) -> bool {
    let Some(hooks) = entry.get("hooks").and_then(|value| value.as_array()) else {
        return false;
    };
    hooks.iter().any(|hook| {
        let Some(command) = hook.get("command").and_then(|value| value.as_str()) else {
            return false;
        };
        hook.get("type").and_then(|value| value.as_str()) == Some("command")
            && is_agent_office_command(command, adapter_path)
    })
}

fn has_exact_agent_office_command(entry: &Value, command: &str) -> bool {
    entry
        .get("hooks")
        .and_then(|value| value.as_array())
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("type").and_then(|value| value.as_str()) == Some("command")
                    && hook.get("command").and_then(|value| value.as_str()) == Some(command)
            })
        })
}

fn is_agent_office_command(command: &str, adapter_path: &Path) -> bool {
    let adapter = path_to_string(adapter_path);
    command.contains(&adapter)
        || command.contains("scripts/codex-hook-adapter.mjs")
        || command.contains("packages/hook-adapter/src/codex-hook-adapter.mjs")
}

fn build_adapter_command(adapter_path: &Path) -> String {
    format!("node {}", shell_quote(&path_to_string(adapter_path)))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn backup_file_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("path has no file name: {}", path.display()))?;
    let stamp = Utc::now()
        .format("%Y%m%dT%H%M%S%.3fZ")
        .to_string()
        .replace('.', "");
    let backup_path = parent.join(format!("{file_name}.agent-office-backup-{stamp}"));
    fs::copy(path, &backup_path).map_err(|error| {
        format!(
            "cannot backup {} to {}: {error}",
            path.display(),
            backup_path.display()
        )
    })?;
    Ok(())
}

fn agent_office_state_dir() -> Result<PathBuf, String> {
    let home = env::var("HOME")
        .map_err(|_| "HOME is required to locate Agent Office state".to_string())?;
    Ok(PathBuf::from(home).join(".agent-office"))
}

fn read_text_tail(path: &Path, max_lines: usize) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let mut lines = text.lines().rev().take(max_lines).collect::<Vec<_>>();
    lines.reverse();
    Ok(Some(lines.join("\n")))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn load_or_create_hook_token() -> Result<String, String> {
    let token_path = hook_token_path()?;
    if token_path.exists() {
        let token = fs::read_to_string(&token_path).map_err(|error| {
            format!(
                "cannot read hook token at {}: {error}",
                token_path.display()
            )
        })?;
        let trimmed = token.trim().to_string();
        if trimmed.is_empty() {
            return Err(format!("hook token at {} is empty", token_path.display()));
        }
        return Ok(trimmed);
    }

    let parent = token_path
        .parent()
        .ok_or_else(|| format!("hook token path has no parent: {}", token_path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "cannot create Agent Office state directory at {}: {error}",
            parent.display()
        )
    })?;

    let token = generate_token()?;
    fs::write(&token_path, format!("{token}\n")).map_err(|error| {
        format!(
            "cannot write hook token at {}: {error}",
            token_path.display()
        )
    })?;
    restrict_token_permissions(&token_path)?;
    Ok(token)
}

fn hook_token_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME is required to locate Agent Office hook token".to_string())?;
    Ok(PathBuf::from(home).join(".agent-office").join("hook-token"))
}

fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("cannot generate hook token: {error}"))?;
    Ok(hex_encode(&bytes))
}

#[cfg(unix)]
fn restrict_token_permissions(path: &PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| {
            format!(
                "cannot read hook token metadata at {}: {error}",
                path.display()
            )
        })?
        .permissions();
    permissions.set_mode(0o600);
    fs::set_permissions(path, permissions).map_err(|error| {
        format!(
            "cannot set hook token permissions at {}: {error}",
            path.display()
        )
    })
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
