use fs2::FileExt;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    cmp::Reverse,
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::NamedTempFile;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const SERVER_NAME: &str = "orion";
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const VAULT_SCHEMA_VERSION: u64 = 2;
const SPACE_SCHEMA_VERSION: u64 = 1;
const MAX_VAULT_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_RESULT_LIMIT: usize = 10;
const MAX_RESULT_LIMIT: usize = 25;
const DEFAULT_BROWSE_LIMIT: usize = 50;
const MAX_BROWSE_LIMIT: usize = 200;
const DEFAULT_BODY_CHARS: usize = 20_000;
const DEFAULT_SOURCE_CHARS: usize = 12_000;
const MAX_CONTENT_CHARS: usize = 50_000;
const MAX_NOTE_BODY_CHARS: usize = 500_000;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const VAULT_LOCK_FILENAME: &str = "vault.lock";
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vault {
    schema_version: u64,
    spaces: Vec<Space>,
    active_space_id: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Space {
    schema_version: u64,
    workspace: Workspace,
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default)]
    sources: Vec<Source>,
    #[serde(default)]
    concepts: Vec<Concept>,
    #[serde(default)]
    relationships: Vec<Relationship>,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    kind: String,
    status: String,
    #[serde(default)]
    concept_ids: Vec<String>,
    #[serde(default)]
    source_ids: Vec<String>,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    pinned: bool,
    color: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    id: String,
    title: String,
    kind: String,
    imported_at: String,
    file_name: Option<String>,
    mime_type: Option<String>,
    byte_size: Option<u64>,
    source_url: Option<String>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    note_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Concept {
    id: String,
    label: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    note_ids: Vec<String>,
    canonical_note_id: Option<String>,
    #[serde(default)]
    auto_link: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Relationship {
    id: String,
    from_note_id: String,
    to_note_id: String,
    kind: String,
    #[serde(default)]
    label: String,
    strength: f64,
    concept_id: Option<String>,
    source_id: Option<String>,
    context: Option<String>,
}

#[derive(Debug)]
struct Server {
    vault_path: PathBuf,
}

#[derive(Debug)]
struct ToolFailure {
    message: String,
}

type ToolResult = Result<Value, ToolFailure>;

impl ToolFailure {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

fn main() -> ExitCode {
    match parse_args(env::args().skip(1)) {
        Ok(Command::Version) => {
            println!("Orion MCP {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Command::Serve(vault_path)) => {
            let server = Server { vault_path };
            match serve(server, io::stdin().lock(), io::stdout().lock()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("Orion MCP stopped: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(message) => {
            eprintln!("{message}");
            eprintln!("usage: orion-mcp [--vault /path/to/vault.json] [--version]");
            ExitCode::from(2)
        }
    }
}

enum Command {
    Serve(PathBuf),
    Version,
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Command, String> {
    let mut vault_override = None;
    let mut args = args.peekable();
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--version" | "-V" => {
                if args.peek().is_some() || vault_override.is_some() {
                    return Err("--version cannot be combined with other options.".to_string());
                }
                return Ok(Command::Version);
            }
            "--vault" => {
                let value = args
                    .next()
                    .ok_or_else(|| "--vault needs a file path.".to_string())?;
                if value.trim().is_empty() {
                    return Err("--vault needs a non-empty file path.".to_string());
                }
                vault_override = Some(PathBuf::from(value));
            }
            _ => return Err(format!("unknown option: {argument}")),
        }
    }

    Ok(Command::Serve(
        vault_override.unwrap_or_else(default_vault_path),
    ))
}

fn default_vault_path() -> PathBuf {
    if let Some(path) = env::var_os("ORION_VAULT_PATH").filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Library")
        .join("Application Support")
        .join("app.orion.knowledge")
        .join("vault.json")
}

fn serve(
    server: Server,
    input: impl BufRead,
    output: impl Write,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut writer = BufWriter::new(output);
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if line.len() > MAX_REQUEST_BYTES {
            let response = json_rpc_error(
                Value::Null,
                -32600,
                "MCP request exceeds Orion's 1 MiB safety limit.",
            );
            serde_json::to_writer(&mut writer, &response)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            continue;
        }

        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => server.handle_request(request),
            Err(error) => Some(json_rpc_error(
                Value::Null,
                -32700,
                format!("Invalid JSON: {error}"),
            )),
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut writer, &response)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
    }
    Ok(())
}

impl Server {
    fn handle_request(&self, request: Value) -> Option<Value> {
        let object = match request.as_object() {
            Some(object) => object,
            None => return Some(json_rpc_error(Value::Null, -32600, "Invalid request.")),
        };
        let id = object.get("id").cloned();
        let method = object.get("method").and_then(Value::as_str);

        // MCP notifications intentionally have no response.
        if id.is_none() {
            return None;
        }
        let id = id.unwrap_or(Value::Null);
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(json_rpc_error(id, -32600, "Expected JSON-RPC 2.0."));
        }

        match method {
            Some("initialize") => Some(json_rpc_success(id, self.initialize(object.get("params")))),
            Some("ping") => Some(json_rpc_success(id, json!({}))),
            Some("tools/list") => {
                Some(json_rpc_success(id, json!({ "tools": tool_definitions() })))
            }
            Some("tools/call") => Some(self.call_tool_request(id, object.get("params"))),
            Some(_) => Some(json_rpc_error(id, -32601, "Method not found.")),
            None => Some(json_rpc_error(id, -32600, "Request method is missing.")),
        }
    }

    fn initialize(&self, params: Option<&Value>) -> Value {
        let requested = params
            .and_then(|value| value.get("protocolVersion"))
            .and_then(Value::as_str);
        let protocol_version = requested
            .filter(|version| SUPPORTED_PROTOCOL_VERSIONS.contains(version))
            .unwrap_or(LATEST_PROTOCOL_VERSION);
        json!({
            "protocolVersion": protocol_version,
            "capabilities": {
                "tools": {
                    "listChanged": false
                }
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "title": "Orion Knowledge Atlas",
                "version": env!("CARGO_PKG_VERSION")
            },
            "instructions": concat!(
                "Read and write the user's local Orion knowledge atlas. ",
                "Orion separates projects into Spaces: search defaults to the active Space, ",
                "and note tools require an explicit space_id. Use the returned Orion citation ",
                "links when referencing notes. Note creation and editing are immediately saved; ",
                "do not add attribution, proposal, or review language unless the user asks for it. ",
                "Use source text only when the user needs its evidence."
            )
        })
    }

    fn call_tool_request(&self, id: Value, params: Option<&Value>) -> Value {
        let Some(params) = params.and_then(Value::as_object) else {
            return json_rpc_error(id, -32602, "tools/call params must be an object.");
        };
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return json_rpc_error(id, -32602, "Tool name is required.");
        };
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(arguments)) => arguments.clone(),
            Some(_) => {
                return json_rpc_error(id, -32602, "Tool arguments must be an object.");
            }
        };

        let result = match self.call_tool(name, &arguments) {
            Ok(structured) => tool_response(structured, false),
            Err(error) => tool_response(json!({ "error": error.message }), true),
        };
        json_rpc_success(id, result)
    }

    fn call_tool(&self, name: &str, arguments: &Map<String, Value>) -> ToolResult {
        if !matches!(
            name,
            "orion_list_spaces"
                | "orion_browse_space"
                | "orion_search"
                | "orion_get_note"
                | "orion_get_source"
                | "orion_create_note"
                | "orion_update_note"
                | "orion_delete_note"
        ) {
            return Err(ToolFailure::new(format!("Unknown Orion tool: {name}")));
        }
        match name {
            "orion_create_note" => create_note(&self.vault_path, arguments),
            "orion_update_note" => update_note(&self.vault_path, arguments),
            "orion_delete_note" => delete_note(&self.vault_path, arguments),
            "orion_list_spaces" | "orion_browse_space" | "orion_search" | "orion_get_note"
            | "orion_get_source" => {
                let vault = read_vault(&self.vault_path)?;
                match name {
                    "orion_list_spaces" => list_spaces(&vault),
                    "orion_browse_space" => browse_space(&vault, arguments),
                    "orion_search" => search_space(&vault, arguments),
                    "orion_get_note" => get_note(&vault, arguments),
                    "orion_get_source" => get_source(&vault, arguments),
                    _ => unreachable!("read tool name was validated above"),
                }
            }
            _ => unreachable!("tool name was validated above"),
        }
    }
}

fn tool_definitions() -> Vec<Value> {
    let read_annotations = json!({
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
    });
    let write_annotations = json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
    });
    let delete_annotations = json!({
        "readOnlyHint": false,
        "destructiveHint": true,
        "idempotentHint": true,
        "openWorldHint": false
    });
    vec![
        json!({
            "name": "orion_list_spaces",
            "title": "List Orion Spaces",
            "description": "List Orion Spaces and their content counts. This reveals metadata only, not note contents.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            },
            "annotations": read_annotations.clone()
        }),
        json!({
            "name": "orion_browse_space",
            "title": "Browse an Orion Space",
            "description": "Browse note metadata in one explicitly selected Orion Space.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "space_id": {
                        "type": "string",
                        "description": "Exact Space ID returned by orion_list_spaces."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_BROWSE_LIMIT,
                        "default": DEFAULT_BROWSE_LIMIT
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 0
                    }
                },
                "required": ["space_id"],
                "additionalProperties": false
            },
            "annotations": read_annotations.clone()
        }),
        json!({
            "name": "orion_search",
            "title": "Search Orion",
            "description": "Search notes and concepts in one Orion Space. Defaults to the active Space and never searches all Spaces at once.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                    },
                    "space_id": {
                        "type": "string",
                        "description": "Optional exact Space ID. Omit to search only the active Space."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_RESULT_LIMIT,
                        "default": DEFAULT_RESULT_LIMIT
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            },
            "annotations": read_annotations.clone()
        }),
        json!({
            "name": "orion_get_note",
            "title": "Read an Orion Note",
            "description": "Read one note plus its Space-scoped concepts, sources, and connected notes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "space_id": {
                        "type": "string",
                        "description": "Exact Space ID returned by orion_list_spaces."
                    },
                    "note_id": {
                        "type": "string",
                        "description": "Exact note ID returned by browse or search."
                    },
                    "max_chars": {
                        "type": "integer",
                        "minimum": 1000,
                        "maximum": MAX_CONTENT_CHARS,
                        "default": DEFAULT_BODY_CHARS,
                        "description": "Maximum Unicode characters of note body to return."
                    }
                },
                "required": ["space_id", "note_id"],
                "additionalProperties": false
            },
            "annotations": read_annotations.clone()
        }),
        json!({
            "name": "orion_get_source",
            "title": "Read an Orion Source",
            "description": "Read bounded extracted text from one source in one explicitly selected Space.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "space_id": {
                        "type": "string",
                        "description": "Exact Space ID returned by orion_list_spaces."
                    },
                    "source_id": {
                        "type": "string",
                        "description": "Exact source ID returned by a note."
                    },
                    "max_chars": {
                        "type": "integer",
                        "minimum": 1000,
                        "maximum": MAX_CONTENT_CHARS,
                        "default": DEFAULT_SOURCE_CHARS,
                        "description": "Maximum Unicode characters of extracted source text to return."
                    }
                },
                "required": ["space_id", "source_id"],
                "additionalProperties": false
            },
            "annotations": read_annotations
        }),
        json!({
            "name": "orion_create_note",
            "title": "Create an Orion Note",
            "description": "Create and immediately save a complete note in one explicitly selected Orion Space. The note is an ordinary Orion note with no agent attribution.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "space_id": {
                        "type": "string",
                        "description": "Exact Space ID returned by orion_list_spaces."
                    },
                    "title": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 300
                    },
                    "body": {
                        "type": "string",
                        "maxLength": MAX_NOTE_BODY_CHARS,
                        "description": "Complete note body in readable Markdown. Do not use [[wiki-link]] brackets."
                    },
                    "summary": {
                        "type": "string",
                        "maxLength": 1000
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["article", "wiki", "hub", "person", "place", "project", "idea"],
                        "default": "article"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["draft", "ready", "archived"],
                        "default": "ready"
                    },
                    "aliases": {
                        "type": "array",
                        "maxItems": 30,
                        "items": { "type": "string", "maxLength": 200 }
                    },
                    "tags": {
                        "type": "array",
                        "maxItems": 50,
                        "items": { "type": "string", "maxLength": 100 }
                    },
                    "pinned": {
                        "type": "boolean",
                        "default": false
                    }
                },
                "required": ["space_id", "title", "body"],
                "additionalProperties": false
            },
            "annotations": write_annotations.clone()
        }),
        json!({
            "name": "orion_update_note",
            "title": "Edit an Orion Note",
            "description": "Immediately edit any supplied fields on an existing note in one Orion Space. Omitted fields remain unchanged.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "space_id": {
                        "type": "string",
                        "description": "Exact Space ID returned by orion_list_spaces."
                    },
                    "note_id": {
                        "type": "string",
                        "description": "Exact note ID returned by browse or search."
                    },
                    "title": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "body": { "type": "string", "maxLength": MAX_NOTE_BODY_CHARS },
                    "summary": { "type": "string", "maxLength": 1000 },
                    "kind": {
                        "type": "string",
                        "enum": ["article", "wiki", "hub", "person", "place", "project", "idea"]
                    },
                    "status": {
                        "type": "string",
                        "enum": ["draft", "ready", "archived"]
                    },
                    "aliases": {
                        "type": "array",
                        "maxItems": 30,
                        "items": { "type": "string", "maxLength": 200 }
                    },
                    "tags": {
                        "type": "array",
                        "maxItems": 50,
                        "items": { "type": "string", "maxLength": 100 }
                    },
                    "pinned": { "type": "boolean" }
                },
                "required": ["space_id", "note_id"],
                "additionalProperties": false
            },
            "annotations": write_annotations
        }),
        json!({
            "name": "orion_delete_note",
            "title": "Delete an Orion Note",
            "description": "Permanently delete a note from one Orion Space and clean its source, concept, and relationship references.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "space_id": {
                        "type": "string",
                        "description": "Exact Space ID returned by orion_list_spaces."
                    },
                    "note_id": {
                        "type": "string",
                        "description": "Exact note ID returned by browse or search."
                    }
                },
                "required": ["space_id", "note_id"],
                "additionalProperties": false
            },
            "annotations": delete_annotations
        }),
    ]
}

fn read_vault(path: &Path) -> Result<Vault, ToolFailure> {
    let lock = open_vault_lock(path)?;
    lock.lock_shared()
        .map_err(|error| ToolFailure::new(format!("Orion could not lock the vault: {error}")))?;
    read_vault_unlocked(path)
}

fn read_vault_unlocked(path: &Path) -> Result<Vault, ToolFailure> {
    let value = read_vault_value_unlocked(path)?;
    validate_vault_value(value)
}

fn read_vault_value_unlocked(path: &Path) -> Result<Value, ToolFailure> {
    let file = File::open(path).map_err(|error| {
        ToolFailure::new(format!(
            "Orion's vault could not be opened at {}: {error}. Open Orion once or choose the correct vault.json in the Claude extension settings.",
            path.display()
        ))
    })?;
    let metadata = file.metadata().map_err(|error| {
        ToolFailure::new(format!("Orion's vault metadata could not be read: {error}"))
    })?;
    if metadata.len() > MAX_VAULT_BYTES {
        return Err(ToolFailure::new(format!(
            "Orion's vault is larger than the connector's {} MiB safety limit.",
            MAX_VAULT_BYTES / (1024 * 1024)
        )));
    }
    serde_json::from_reader(BufReader::new(file))
        .map_err(|error| ToolFailure::new(format!("Orion's vault JSON is invalid: {error}")))
}

fn validate_vault_value(value: Value) -> Result<Vault, ToolFailure> {
    let vault: Vault = serde_json::from_value(value)
        .map_err(|error| ToolFailure::new(format!("Orion's vault JSON is invalid: {error}")))?;
    if vault.schema_version != VAULT_SCHEMA_VERSION {
        return Err(ToolFailure::new(format!(
            "Unsupported Orion vault schema {} (expected {}). Update Orion and its Claude connector together.",
            vault.schema_version, VAULT_SCHEMA_VERSION
        )));
    }
    if vault
        .spaces
        .iter()
        .any(|space| space.schema_version != SPACE_SCHEMA_VERSION)
    {
        return Err(ToolFailure::new(format!(
            "An Orion Space uses an unsupported schema (expected {}).",
            SPACE_SCHEMA_VERSION
        )));
    }
    if !vault.spaces.is_empty()
        && !vault
            .spaces
            .iter()
            .any(|space| space.workspace.id == vault.active_space_id)
    {
        return Err(ToolFailure::new(
            "Orion's active Space ID does not exist in the vault.",
        ));
    }
    Ok(vault)
}

fn open_vault_lock(path: &Path) -> Result<File, ToolFailure> {
    let directory = path
        .parent()
        .ok_or_else(|| ToolFailure::new("Orion could not resolve the vault folder."))?;
    fs::create_dir_all(directory).map_err(|error| {
        ToolFailure::new(format!("Orion could not create its vault folder: {error}"))
    })?;
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(directory.join(VAULT_LOCK_FILENAME))
        .map_err(|error| ToolFailure::new(format!("Orion could not open its vault lock: {error}")))
}

fn write_vault_value_unlocked(path: &Path, value: &Value) -> Result<(), ToolFailure> {
    let directory = path
        .parent()
        .ok_or_else(|| ToolFailure::new("Orion could not resolve the vault folder."))?;
    let mut temporary = NamedTempFile::new_in(directory).map_err(|error| {
        ToolFailure::new(format!("Orion could not prepare the vault update: {error}"))
    })?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), value)
        .map_err(|error| ToolFailure::new(format!("Orion could not encode the vault: {error}")))?;
    temporary
        .as_file_mut()
        .write_all(b"\n")
        .and_then(|_| temporary.as_file_mut().flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| {
            ToolFailure::new(format!("Orion could not secure the vault update: {error}"))
        })?;
    temporary.persist(path).map_err(|error| {
        ToolFailure::new(format!(
            "Orion could not replace the vault atomically: {}",
            error.error
        ))
    })?;
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| {
            ToolFailure::new(format!("Orion could not finish the vault update: {error}"))
        })
}

fn mutate_vault(path: &Path, mutation: impl FnOnce(&mut Value) -> ToolResult) -> ToolResult {
    let lock = open_vault_lock(path)?;
    lock.lock_exclusive().map_err(|error| {
        ToolFailure::new(format!(
            "Orion could not lock the vault for editing: {error}"
        ))
    })?;
    let mut value = read_vault_value_unlocked(path)?;
    validate_vault_value(value.clone())?;
    let result = mutation(&mut value)?;
    validate_vault_value(value.clone())?;
    write_vault_value_unlocked(path, &value)?;
    Ok(result)
}

fn list_spaces(vault: &Vault) -> ToolResult {
    let spaces = vault
        .spaces
        .iter()
        .map(|space| {
            json!({
                "id": space.workspace.id,
                "name": space.workspace.name,
                "description": space.workspace.description,
                "createdAt": space.workspace.created_at,
                "updatedAt": space.updated_at,
                "active": space.workspace.id == vault.active_space_id,
                "counts": {
                    "notes": space.notes.len(),
                    "sources": space.sources.len(),
                    "concepts": space.concepts.len(),
                    "relationships": space.relationships.len()
                }
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "activeSpaceId": vault.active_space_id,
        "vaultUpdatedAt": vault.updated_at,
        "spaces": spaces
    }))
}

fn browse_space(vault: &Vault, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(arguments, &["space_id", "limit", "offset"])?;
    let space_id = required_string(arguments, "space_id", 200)?;
    let space = require_space(vault, &space_id)?;
    let limit = integer_argument(
        arguments,
        "limit",
        DEFAULT_BROWSE_LIMIT,
        1,
        MAX_BROWSE_LIMIT,
    )?;
    let offset = integer_argument(arguments, "offset", 0, 0, usize::MAX)?;

    let mut notes = space.notes.iter().collect::<Vec<_>>();
    notes.sort_by_key(|note| (Reverse(note.updated_at.as_str()), note.title.as_str()));
    let page = notes
        .iter()
        .skip(offset)
        .take(limit)
        .map(|note| note_metadata(note, &space_id))
        .collect::<Vec<_>>();
    let returned_through = offset.saturating_add(page.len());
    Ok(json!({
        "space": space_metadata(space),
        "total": notes.len(),
        "offset": offset,
        "nextOffset": (returned_through < notes.len()).then_some(returned_through),
        "notes": page
    }))
}

fn search_space(vault: &Vault, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(arguments, &["query", "space_id", "limit"])?;
    let query = required_string(arguments, "query", 200)?;
    let query = query.trim();
    if query.is_empty() {
        return Err(ToolFailure::new("Search query cannot be blank."));
    }
    let space = match optional_string(arguments, "space_id", 200)? {
        Some(space_id) => require_space(vault, &space_id)?,
        None => active_space(vault)?,
    };
    let limit = integer_argument(
        arguments,
        "limit",
        DEFAULT_RESULT_LIMIT,
        1,
        MAX_RESULT_LIMIT,
    )?;
    let normalized_query = query.to_lowercase();
    let query_terms = normalized_query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();
    let mut results = Vec::new();

    for note in &space.notes {
        let title = note.title.to_lowercase();
        let aliases = note.aliases.join(" ").to_lowercase();
        let tags = note.tags.join(" ").to_lowercase();
        let searchable = format!(
            "{} {} {} {} {}",
            title,
            aliases,
            tags,
            note.summary.to_lowercase(),
            note.body.to_lowercase()
        );
        let Some(score) = match_score(
            &normalized_query,
            &query_terms,
            &title,
            &aliases,
            &searchable,
        ) else {
            continue;
        };
        results.push((
            score,
            note.updated_at.as_str(),
            json!({
                "type": "note",
                "id": note.id,
                "title": note.title,
                "kind": note.kind,
                "status": note.status,
                "summary": note.summary,
                "snippet": matching_snippet(&note.body, query, 320),
                "updatedAt": note.updated_at,
                "orionUrl": orion_note_url(&space.workspace.id, &note.id),
                "citation": citation_markdown(&note.title, &space.workspace.id, &note.id)
            }),
        ));
    }
    for concept in &space.concepts {
        let label = concept.label.to_lowercase();
        let aliases = concept.aliases.join(" ").to_lowercase();
        let searchable = format!(
            "{} {} {}",
            label,
            aliases,
            concept.description.to_lowercase()
        );
        let Some(score) = match_score(
            &normalized_query,
            &query_terms,
            &label,
            &aliases,
            &searchable,
        ) else {
            continue;
        };
        results.push((
            score,
            "",
            json!({
                "type": "concept",
                "id": concept.id,
                "label": concept.label,
                "description": concept.description,
                "aliases": concept.aliases,
                "canonicalNoteId": concept.canonical_note_id,
                "noteIds": concept.note_ids,
                "autoLink": concept.auto_link,
                "orionUrl": concept.canonical_note_id.as_ref().map(|note_id| {
                    orion_note_url(&space.workspace.id, note_id)
                })
            }),
        ));
    }
    results.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(left.1)));
    let results = results
        .into_iter()
        .take(limit)
        .map(|(_, _, value)| value)
        .collect::<Vec<_>>();

    Ok(json!({
        "space": space_metadata(space),
        "query": query,
        "results": results
    }))
}

fn get_note(vault: &Vault, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(arguments, &["space_id", "note_id", "max_chars"])?;
    let space_id = required_string(arguments, "space_id", 200)?;
    let note_id = required_string(arguments, "note_id", 200)?;
    let max_chars = integer_argument(
        arguments,
        "max_chars",
        DEFAULT_BODY_CHARS,
        1_000,
        MAX_CONTENT_CHARS,
    )?;
    let space = require_space(vault, &space_id)?;
    let note = space
        .notes
        .iter()
        .find(|note| note.id == note_id)
        .ok_or_else(|| {
            ToolFailure::new(format!(
                "Note ID {note_id:?} does not exist in Space {space_id:?}."
            ))
        })?;
    let (body, body_truncated) = truncate_chars(&note.body, max_chars);
    let sources = note
        .source_ids
        .iter()
        .filter_map(|source_id| space.sources.iter().find(|source| source.id == *source_id))
        .map(source_metadata)
        .collect::<Vec<_>>();
    let concepts = note
        .concept_ids
        .iter()
        .filter_map(|concept_id| {
            space
                .concepts
                .iter()
                .find(|concept| concept.id == *concept_id)
        })
        .map(|concept| concept_metadata(concept, &space_id))
        .collect::<Vec<_>>();
    let connections = space
        .relationships
        .iter()
        .filter_map(|relationship| relationship_for_note(space, relationship, &note.id))
        .collect::<Vec<_>>();

    Ok(json!({
        "space": space_metadata(space),
        "note": {
            "id": note.id,
            "title": note.title,
            "slug": note.slug,
            "summary": note.summary,
            "body": body,
            "bodyTruncated": body_truncated,
            "aliases": note.aliases,
            "tags": note.tags,
            "kind": note.kind,
            "status": note.status,
            "pinned": note.pinned,
            "color": note.color,
            "createdAt": note.created_at,
            "updatedAt": note.updated_at,
            "orionUrl": orion_note_url(&space_id, &note.id),
            "citation": citation_markdown(&note.title, &space_id, &note.id)
        },
        "sources": sources,
        "concepts": concepts,
        "connections": connections
    }))
}

fn get_source(vault: &Vault, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(arguments, &["space_id", "source_id", "max_chars"])?;
    let space_id = required_string(arguments, "space_id", 200)?;
    let source_id = required_string(arguments, "source_id", 200)?;
    let max_chars = integer_argument(
        arguments,
        "max_chars",
        DEFAULT_SOURCE_CHARS,
        1_000,
        MAX_CONTENT_CHARS,
    )?;
    let space = require_space(vault, &space_id)?;
    let source = space
        .sources
        .iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| {
            ToolFailure::new(format!(
                "Source ID {source_id:?} does not exist in Space {space_id:?}."
            ))
        })?;
    let (text, text_truncated) = truncate_chars(&source.text, max_chars);
    let notes = source
        .note_ids
        .iter()
        .filter_map(|note_id| space.notes.iter().find(|note| note.id == *note_id))
        .map(|note| note_metadata(note, &space_id))
        .collect::<Vec<_>>();

    Ok(json!({
        "space": space_metadata(space),
        "source": {
            "id": source.id,
            "title": source.title,
            "kind": source.kind,
            "importedAt": source.imported_at,
            "fileName": source.file_name,
            "mimeType": source.mime_type,
            "byteSize": source.byte_size,
            "sourceUrl": source.source_url,
            "text": text,
            "textTruncated": text_truncated,
            "noteIds": source.note_ids
        },
        "notes": notes
    }))
}

fn create_note(path: &Path, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(
        arguments,
        &[
            "space_id", "title", "body", "summary", "kind", "status", "aliases", "tags", "pinned",
        ],
    )?;
    let space_id = required_string(arguments, "space_id", 200)?;
    let title = required_nonempty_string(arguments, "title", 300)?;
    let body = required_text(arguments, "body", MAX_NOTE_BODY_CHARS)?;
    let summary = optional_string(arguments, "summary", 1_000)?.unwrap_or_default();
    let kind = enum_argument(
        arguments,
        "kind",
        "article",
        &[
            "article", "wiki", "hub", "person", "place", "project", "idea",
        ],
    )?;
    let status = enum_argument(
        arguments,
        "status",
        "ready",
        &["draft", "ready", "archived"],
    )?;
    let aliases = optional_string_array(arguments, "aliases", 30, 200)?.unwrap_or_default();
    let tags = optional_string_array(arguments, "tags", 50, 100)?.unwrap_or_default();
    let pinned = optional_bool(arguments, "pinned")?.unwrap_or(false);
    let now = now_iso()?;
    let note_id = unique_id("note");
    let slug = slugify_title(&title, &note_id);

    mutate_vault(path, |vault| {
        let space = require_space_value_mut(vault, &space_id)?;
        let notes = required_array_mut(space, "notes")?;
        let note = json!({
            "id": note_id,
            "title": title,
            "slug": slug,
            "summary": summary,
            "body": body,
            "aliases": aliases,
            "tags": tags,
            "kind": kind,
            "status": status,
            "conceptIds": [],
            "sourceIds": [],
            "createdAt": now,
            "updatedAt": now,
            "pinned": pinned,
            "color": "#8798ff"
        });
        notes.insert(0, note.clone());
        set_updated_at(space, &now);
        set_updated_at(
            vault
                .as_object_mut()
                .ok_or_else(|| ToolFailure::new("Orion's vault root is invalid."))?,
            &now,
        );
        Ok(json!({
            "spaceId": space_id,
            "created": true,
            "note": note,
            "orionUrl": orion_note_url(&space_id, &note_id),
            "citation": citation_markdown(&title, &space_id, &note_id)
        }))
    })
}

fn update_note(path: &Path, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(
        arguments,
        &[
            "space_id", "note_id", "title", "body", "summary", "kind", "status", "aliases", "tags",
            "pinned",
        ],
    )?;
    let space_id = required_string(arguments, "space_id", 200)?;
    let note_id = required_string(arguments, "note_id", 200)?;
    let title = optional_nonempty_string(arguments, "title", 300)?;
    let body = optional_text(arguments, "body", MAX_NOTE_BODY_CHARS)?;
    let summary = optional_string(arguments, "summary", 1_000)?;
    let kind = optional_enum_argument(
        arguments,
        "kind",
        &[
            "article", "wiki", "hub", "person", "place", "project", "idea",
        ],
    )?;
    let status = optional_enum_argument(arguments, "status", &["draft", "ready", "archived"])?;
    let aliases = optional_string_array(arguments, "aliases", 30, 200)?;
    let tags = optional_string_array(arguments, "tags", 50, 100)?;
    let pinned = optional_bool(arguments, "pinned")?;
    if title.is_none()
        && body.is_none()
        && summary.is_none()
        && kind.is_none()
        && status.is_none()
        && aliases.is_none()
        && tags.is_none()
        && pinned.is_none()
    {
        return Err(ToolFailure::new(
            "Provide at least one note field to update.",
        ));
    }
    let now = now_iso()?;

    mutate_vault(path, |vault| {
        let space = require_space_value_mut(vault, &space_id)?;
        let notes = required_array_mut(space, "notes")?;
        let note = notes
            .iter_mut()
            .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(&note_id))
            .and_then(Value::as_object_mut)
            .ok_or_else(|| {
                ToolFailure::new(format!(
                    "Note ID {note_id:?} does not exist in Space {space_id:?}."
                ))
            })?;
        if let Some(value) = title.as_ref() {
            note.insert("title".to_string(), json!(value));
            note.insert("slug".to_string(), json!(slugify_title(value, &note_id)));
        }
        if let Some(value) = body.as_ref() {
            note.insert("body".to_string(), json!(value));
        }
        if let Some(value) = summary.as_ref() {
            note.insert("summary".to_string(), json!(value));
        }
        if let Some(value) = kind.as_ref() {
            note.insert("kind".to_string(), json!(value));
        }
        if let Some(value) = status.as_ref() {
            note.insert("status".to_string(), json!(value));
        }
        if let Some(value) = aliases.as_ref() {
            note.insert("aliases".to_string(), json!(value));
        }
        if let Some(value) = tags.as_ref() {
            note.insert("tags".to_string(), json!(value));
        }
        if let Some(value) = pinned {
            note.insert("pinned".to_string(), json!(value));
        }
        note.insert("updatedAt".to_string(), json!(now));
        let updated_note = Value::Object(note.clone());
        let updated_title = note
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Orion note")
            .to_string();
        set_updated_at(space, &now);
        set_updated_at(
            vault
                .as_object_mut()
                .ok_or_else(|| ToolFailure::new("Orion's vault root is invalid."))?,
            &now,
        );
        Ok(json!({
            "spaceId": space_id,
            "updated": true,
            "note": updated_note,
            "orionUrl": orion_note_url(&space_id, &note_id),
            "citation": citation_markdown(&updated_title, &space_id, &note_id)
        }))
    })
}

fn delete_note(path: &Path, arguments: &Map<String, Value>) -> ToolResult {
    reject_unknown_arguments(arguments, &["space_id", "note_id"])?;
    let space_id = required_string(arguments, "space_id", 200)?;
    let note_id = required_string(arguments, "note_id", 200)?;
    let now = now_iso()?;

    mutate_vault(path, |vault| {
        let space = require_space_value_mut(vault, &space_id)?;
        let notes = required_array_mut(space, "notes")?;
        let position = notes
            .iter()
            .position(|note| note.get("id").and_then(Value::as_str) == Some(&note_id))
            .ok_or_else(|| {
                ToolFailure::new(format!(
                    "Note ID {note_id:?} does not exist in Space {space_id:?}."
                ))
            })?;
        let removed = notes.remove(position);
        let title = removed
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled note")
            .to_string();

        let concepts = required_array_mut(space, "concepts")?;
        for concept in concepts.iter_mut().filter_map(Value::as_object_mut) {
            remove_id_from_array_field(concept, "noteIds", &note_id);
            if concept.get("canonicalNoteId").and_then(Value::as_str) == Some(&note_id) {
                concept.insert("canonicalNoteId".to_string(), Value::Null);
            }
        }
        let removed_concept_ids = concepts
            .iter()
            .filter(|concept| {
                concept
                    .get("noteIds")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
            })
            .filter_map(|concept| concept.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>();
        concepts.retain(|concept| {
            !concept
                .get("noteIds")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
        });

        for note in required_array_mut(space, "notes")?
            .iter_mut()
            .filter_map(Value::as_object_mut)
        {
            for concept_id in &removed_concept_ids {
                remove_id_from_array_field(note, "conceptIds", concept_id);
            }
            if let Some(body) = note.get("body").and_then(Value::as_str) {
                let mut cleaned = strip_orion_link_target(body, "note", &note_id);
                for concept_id in &removed_concept_ids {
                    cleaned = strip_orion_link_target(&cleaned, "concept", concept_id);
                }
                if cleaned != body {
                    note.insert("body".to_string(), json!(cleaned));
                    note.insert("updatedAt".to_string(), json!(now));
                }
            }
        }
        for source in required_array_mut(space, "sources")?
            .iter_mut()
            .filter_map(Value::as_object_mut)
        {
            remove_id_from_array_field(source, "noteIds", &note_id);
        }
        required_array_mut(space, "relationships")?.retain(|relationship| {
            let from = relationship.get("fromNoteId").and_then(Value::as_str);
            let to = relationship.get("toNoteId").and_then(Value::as_str);
            let concept = relationship.get("conceptId").and_then(Value::as_str);
            from != Some(&note_id)
                && to != Some(&note_id)
                && !concept
                    .is_some_and(|id| removed_concept_ids.iter().any(|removed| removed == id))
        });
        if let Some(drafts) = space.get_mut("importDrafts").and_then(Value::as_array_mut) {
            for draft in drafts.iter_mut().filter_map(Value::as_object_mut) {
                remove_id_from_array_field(draft, "generatedNoteIds", &note_id);
            }
        }
        if space.get("activeNoteId").and_then(Value::as_str) == Some(&note_id) {
            space.insert("activeNoteId".to_string(), Value::Null);
        }
        set_updated_at(space, &now);
        set_updated_at(
            vault
                .as_object_mut()
                .ok_or_else(|| ToolFailure::new("Orion's vault root is invalid."))?,
            &now,
        );
        Ok(json!({
            "spaceId": space_id,
            "noteId": note_id,
            "title": title,
            "deleted": true
        }))
    })
}

fn require_space_value_mut<'a>(
    vault: &'a mut Value,
    space_id: &str,
) -> Result<&'a mut Map<String, Value>, ToolFailure> {
    vault
        .get_mut("spaces")
        .and_then(Value::as_array_mut)
        .and_then(|spaces| {
            spaces.iter_mut().find(|space| {
                space
                    .get("workspace")
                    .and_then(|workspace| workspace.get("id"))
                    .and_then(Value::as_str)
                    == Some(space_id)
            })
        })
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ToolFailure::new(format!("Unknown Orion Space ID: {space_id:?}")))
}

fn required_array_mut<'a>(
    object: &'a mut Map<String, Value>,
    name: &str,
) -> Result<&'a mut Vec<Value>, ToolFailure> {
    object
        .get_mut(name)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ToolFailure::new(format!("Orion's {name} collection is invalid.")))
}

fn set_updated_at(object: &mut Map<String, Value>, now: &str) {
    object.insert("updatedAt".to_string(), json!(now));
}

fn remove_id_from_array_field(object: &mut Map<String, Value>, field: &str, id: &str) {
    if let Some(values) = object.get_mut(field).and_then(Value::as_array_mut) {
        values.retain(|value| value.as_str() != Some(id));
    }
}

fn strip_orion_link_target(markdown: &str, kind: &str, id: &str) -> String {
    let target = format!("](orion-{kind}://{id})");
    let mut remaining = markdown;
    let mut output = String::with_capacity(markdown.len());
    while let Some(target_start) = remaining.find(&target) {
        let Some(label_start) = remaining[..target_start].rfind('[') else {
            break;
        };
        output.push_str(&remaining[..label_start]);
        output.push_str(&remaining[label_start + 1..target_start]);
        remaining = &remaining[target_start + target.len()..];
    }
    output.push_str(remaining);
    output
}

fn require_space<'a>(vault: &'a Vault, space_id: &str) -> Result<&'a Space, ToolFailure> {
    vault
        .spaces
        .iter()
        .find(|space| space.workspace.id == space_id)
        .ok_or_else(|| ToolFailure::new(format!("Unknown Orion Space ID: {space_id:?}")))
}

fn active_space(vault: &Vault) -> Result<&Space, ToolFailure> {
    if vault.spaces.is_empty() {
        return Err(ToolFailure::new("Orion does not contain any Spaces yet."));
    }
    require_space(vault, &vault.active_space_id)
}

fn space_metadata(space: &Space) -> Value {
    json!({
        "id": space.workspace.id,
        "name": space.workspace.name,
        "description": space.workspace.description,
        "updatedAt": space.updated_at
    })
}

fn note_metadata(note: &Note, space_id: &str) -> Value {
    json!({
        "id": note.id,
        "title": note.title,
        "summary": note.summary,
        "aliases": note.aliases,
        "tags": note.tags,
        "kind": note.kind,
        "status": note.status,
        "pinned": note.pinned,
        "sourceCount": note.source_ids.len(),
        "conceptCount": note.concept_ids.len(),
        "createdAt": note.created_at,
        "updatedAt": note.updated_at,
        "orionUrl": orion_note_url(space_id, &note.id),
        "citation": citation_markdown(&note.title, space_id, &note.id)
    })
}

fn source_metadata(source: &Source) -> Value {
    json!({
        "id": source.id,
        "title": source.title,
        "kind": source.kind,
        "importedAt": source.imported_at,
        "fileName": source.file_name,
        "mimeType": source.mime_type,
        "byteSize": source.byte_size,
        "sourceUrl": source.source_url
    })
}

fn concept_metadata(concept: &Concept, space_id: &str) -> Value {
    json!({
        "id": concept.id,
        "label": concept.label,
        "aliases": concept.aliases,
        "description": concept.description,
        "canonicalNoteId": concept.canonical_note_id,
        "noteIds": concept.note_ids,
        "autoLink": concept.auto_link,
        "orionUrl": concept
            .canonical_note_id
            .as_ref()
            .map(|note_id| orion_note_url(space_id, note_id))
    })
}

fn relationship_for_note(
    space: &Space,
    relationship: &Relationship,
    note_id: &str,
) -> Option<Value> {
    let (direction, other_note_id) = if relationship.from_note_id == note_id {
        ("outgoing", relationship.to_note_id.as_str())
    } else if relationship.to_note_id == note_id {
        ("incoming", relationship.from_note_id.as_str())
    } else {
        return None;
    };
    let other_note = space.notes.iter().find(|note| note.id == other_note_id);
    Some(json!({
        "id": relationship.id,
        "direction": direction,
        "kind": relationship.kind,
        "label": relationship.label,
        "strength": relationship.strength,
        "context": relationship.context,
        "conceptId": relationship.concept_id,
        "sourceId": relationship.source_id,
        "note": other_note.map(|note| note_metadata(note, &space.workspace.id)).unwrap_or_else(|| json!({
            "id": other_note_id,
            "missing": true
        }))
    }))
}

fn match_score(
    query: &str,
    query_terms: &[&str],
    title: &str,
    aliases: &str,
    searchable: &str,
) -> Option<u32> {
    let mut score = 0;
    if title == query {
        score += 1_000;
    } else if title.starts_with(query) {
        score += 600;
    } else if title.contains(query) {
        score += 400;
    }
    if aliases.split_whitespace().any(|alias| alias == query) {
        score += 500;
    } else if aliases.contains(query) {
        score += 250;
    }
    if searchable.contains(query) {
        score += 160;
    }
    for term in query_terms {
        if searchable.contains(term) {
            score += 20;
        } else {
            return (score > 0).then_some(score);
        }
    }
    (score > 0).then_some(score)
}

fn matching_snippet(text: &str, query: &str, max_chars: usize) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lower = text.to_lowercase();
    let query = query.to_lowercase();
    let start_byte = lower.find(&query).unwrap_or(0);
    let chars = text.chars().collect::<Vec<_>>();
    let match_char = lower[..start_byte].chars().count().min(chars.len());
    let start_char = match_char.saturating_sub(max_chars / 4);
    let end_char = (start_char + max_chars).min(chars.len());
    let mut snippet = chars[start_char..end_char].iter().collect::<String>();
    if start_char > 0 {
        snippet.insert(0, '…');
    }
    if end_char < chars.len() {
        snippet.push('…');
    }
    snippet
}

fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    let mut chars = text.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    let has_more = chars.next().is_some();
    (truncated, has_more)
}

fn now_iso() -> Result<String, ToolFailure> {
    OffsetDateTime::now_utc().format(&Rfc3339).map_err(|error| {
        ToolFailure::new(format!("Orion could not create a note timestamp: {error}"))
    })
}

fn unique_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{nanos:x}{sequence:x}")
}

fn slugify_title(title: &str, fallback_id: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for character in title.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(character);
        } else {
            pending_dash = true;
        }
    }
    if slug.is_empty() {
        fallback_id.to_string()
    } else {
        slug
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn orion_note_url(space_id: &str, note_id: &str) -> String {
    format!(
        "orion://open?space_id={}&note_id={}",
        percent_encode(space_id),
        percent_encode(note_id)
    )
}

fn citation_markdown(title: &str, space_id: &str, note_id: &str) -> String {
    let label = title
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    format!("[{label}]({})", orion_note_url(space_id, note_id))
}

fn required_nonempty_string(
    arguments: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<String, ToolFailure> {
    optional_nonempty_string(arguments, name, max_chars)?
        .ok_or_else(|| ToolFailure::new(format!("Missing required argument: {name}")))
}

fn optional_nonempty_string(
    arguments: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<Option<String>, ToolFailure> {
    let Some(value) = optional_string(arguments, name, max_chars)? else {
        return Ok(None);
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(ToolFailure::new(format!("{name} cannot be empty.")));
    }
    Ok(Some(normalized.to_string()))
}

fn required_text(
    arguments: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<String, ToolFailure> {
    optional_text(arguments, name, max_chars)?
        .ok_or_else(|| ToolFailure::new(format!("Missing required argument: {name}")))
}

fn optional_text(
    arguments: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<Option<String>, ToolFailure> {
    let Some(value) = arguments.get(name) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| ToolFailure::new(format!("{name} must be a string.")))?;
    if value.chars().count() > max_chars {
        return Err(ToolFailure::new(format!(
            "{name} cannot exceed {max_chars} characters."
        )));
    }
    Ok(Some(value.to_string()))
}

fn optional_string_array(
    arguments: &Map<String, Value>,
    name: &str,
    max_items: usize,
    max_chars: usize,
) -> Result<Option<Vec<String>>, ToolFailure> {
    let Some(value) = arguments.get(name) else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| ToolFailure::new(format!("{name} must be an array of strings.")))?;
    if values.len() > max_items {
        return Err(ToolFailure::new(format!(
            "{name} cannot contain more than {max_items} items."
        )));
    }
    let mut normalized = Vec::new();
    for value in values {
        let value = value
            .as_str()
            .ok_or_else(|| ToolFailure::new(format!("{name} must contain only strings.")))?
            .trim();
        if value.is_empty()
            || value.chars().count() > max_chars
            || value.chars().any(char::is_control)
        {
            return Err(ToolFailure::new(format!(
                "Each {name} item must be non-empty and no longer than {max_chars} characters."
            )));
        }
        if !normalized.iter().any(|existing| existing == value) {
            normalized.push(value.to_string());
        }
    }
    Ok(Some(normalized))
}

fn optional_bool(arguments: &Map<String, Value>, name: &str) -> Result<Option<bool>, ToolFailure> {
    arguments
        .get(name)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| ToolFailure::new(format!("{name} must be a boolean.")))
        })
        .transpose()
}

fn optional_enum_argument(
    arguments: &Map<String, Value>,
    name: &str,
    allowed: &[&str],
) -> Result<Option<String>, ToolFailure> {
    let Some(value) = optional_string(arguments, name, 40)? else {
        return Ok(None);
    };
    if !allowed.contains(&value.as_str()) {
        return Err(ToolFailure::new(format!(
            "{name} must be one of: {}.",
            allowed.join(", ")
        )));
    }
    Ok(Some(value))
}

fn enum_argument(
    arguments: &Map<String, Value>,
    name: &str,
    default: &str,
    allowed: &[&str],
) -> Result<String, ToolFailure> {
    Ok(optional_enum_argument(arguments, name, allowed)?.unwrap_or_else(|| default.to_string()))
}

fn required_string(
    arguments: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<String, ToolFailure> {
    optional_string(arguments, name, max_chars)?
        .ok_or_else(|| ToolFailure::new(format!("Missing required argument: {name}")))
}

fn optional_string(
    arguments: &Map<String, Value>,
    name: &str,
    max_chars: usize,
) -> Result<Option<String>, ToolFailure> {
    let Some(value) = arguments.get(name) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| ToolFailure::new(format!("{name} must be a string.")))?;
    if value.chars().count() > max_chars {
        return Err(ToolFailure::new(format!(
            "{name} cannot exceed {max_chars} characters."
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(ToolFailure::new(format!(
            "{name} cannot contain control characters."
        )));
    }
    Ok(Some(value.to_string()))
}

fn integer_argument(
    arguments: &Map<String, Value>,
    name: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, ToolFailure> {
    let Some(value) = arguments.get(name) else {
        return Ok(default);
    };
    let value = value
        .as_u64()
        .and_then(|number| usize::try_from(number).ok())
        .ok_or_else(|| ToolFailure::new(format!("{name} must be a positive integer.")))?;
    if value < minimum || value > maximum {
        return Err(ToolFailure::new(format!(
            "{name} must be between {minimum} and {maximum}."
        )));
    }
    Ok(value)
}

fn reject_unknown_arguments(
    arguments: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), ToolFailure> {
    if let Some(name) = arguments
        .keys()
        .find(|name| !allowed.contains(&name.as_str()))
    {
        return Err(ToolFailure::new(format!("Unknown tool argument: {name}")));
    }
    Ok(())
}

fn tool_response(structured: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&structured)
        .unwrap_or_else(|_| "{\"error\":\"Could not serialize Orion result.\"}".to_string());
    json!({
        "content": [{
            "type": "text",
            "text": text
        }],
        "structuredContent": structured,
        "isError": is_error
    })
}

fn json_rpc_success(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
}

fn json_rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn fixture_vault() -> Value {
        json!({
            "schemaVersion": 2,
            "activeSpaceId": "space-alpha",
            "updatedAt": "2026-07-31T00:00:00.000Z",
            "spaces": [
                {
                    "schemaVersion": 1,
                    "workspace": {
                        "id": "space-alpha",
                        "name": "Alpha",
                        "description": "The active project",
                        "createdAt": "2026-07-30T00:00:00.000Z"
                    },
                    "notes": [{
                        "id": "note-comte",
                        "title": "Auguste Comte",
                        "slug": "auguste-comte",
                        "summary": "A philosopher of positivism.",
                        "body": "Comte developed positivism and a hierarchy of sciences.",
                        "aliases": ["Comte"],
                        "tags": ["sociology"],
                        "kind": "person",
                        "status": "ready",
                        "conceptIds": ["concept-comte"],
                        "sourceIds": ["source-lecture"],
                        "createdAt": "2026-07-30T00:00:00.000Z",
                        "updatedAt": "2026-07-31T00:00:00.000Z"
                    }],
                    "sources": [{
                        "id": "source-lecture",
                        "title": "Lecture",
                        "kind": "text",
                        "importedAt": "2026-07-31T00:00:00.000Z",
                        "text": "source evidence ".repeat(1000),
                        "noteIds": ["note-comte"]
                    }],
                    "concepts": [{
                        "id": "concept-comte",
                        "label": "Auguste Comte",
                        "aliases": ["Comte"],
                        "description": "French philosopher",
                        "noteIds": ["note-comte"],
                        "canonicalNoteId": "note-comte",
                        "color": "#fff",
                        "autoLink": true
                    }],
                    "relationships": [],
                    "importDrafts": [],
                    "studio": {},
                    "settings": {},
                    "activeNoteId": "note-comte",
                    "updatedAt": "2026-07-31T00:00:00.000Z"
                },
                {
                    "schemaVersion": 1,
                    "workspace": {
                        "id": "space-private",
                        "name": "Private",
                        "description": "Another project",
                        "createdAt": "2026-07-30T00:00:00.000Z"
                    },
                    "notes": [{
                        "id": "note-secret",
                        "title": "Secluded topic",
                        "slug": "secluded-topic",
                        "summary": "Only in the second Space.",
                        "body": "purple-capybara",
                        "aliases": [],
                        "tags": [],
                        "kind": "article",
                        "status": "ready",
                        "conceptIds": [],
                        "sourceIds": [],
                        "createdAt": "2026-07-30T00:00:00.000Z",
                        "updatedAt": "2026-07-31T00:00:00.000Z"
                    }],
                    "sources": [],
                    "concepts": [],
                    "relationships": [],
                    "importDrafts": [],
                    "studio": {},
                    "settings": {},
                    "activeNoteId": "note-secret",
                    "updatedAt": "2026-07-31T00:00:00.000Z"
                }
            ]
        })
    }

    fn server_with_fixture() -> (tempfile::TempDir, Server) {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("vault.json");
        fs::write(
            &path,
            serde_json::to_vec(&fixture_vault()).expect("serialize fixture"),
        )
        .expect("write fixture");
        (directory, Server { vault_path: path })
    }

    #[test]
    fn initialize_and_tool_list_follow_mcp_shape() {
        let (_directory, server) = server_with_fixture();
        let initialize = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-06-18" }
            }))
            .expect("response");
        assert_eq!(
            initialize["result"]["protocolVersion"],
            Value::String("2025-06-18".to_string())
        );
        assert_eq!(initialize["result"]["serverInfo"]["name"], SERVER_NAME);

        let tools = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }))
            .expect("response");
        assert_eq!(tools["result"]["tools"].as_array().map(Vec::len), Some(8));
    }

    #[test]
    fn search_defaults_to_active_space_without_leaking_other_spaces() {
        let (_directory, server) = server_with_fixture();
        let response = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "orion_search",
                    "arguments": { "query": "purple-capybara" }
                }
            }))
            .expect("response");
        assert_eq!(
            response["result"]["structuredContent"]["space"]["id"],
            "space-alpha"
        );
        assert_eq!(
            response["result"]["structuredContent"]["results"]
                .as_array()
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn note_lookup_requires_the_matching_space() {
        let (_directory, server) = server_with_fixture();
        let response = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "orion_get_note",
                    "arguments": {
                        "space_id": "space-alpha",
                        "note_id": "note-secret"
                    }
                }
            }))
            .expect("response");
        assert_eq!(response["result"]["isError"], true);
    }

    #[test]
    fn source_text_is_bounded() {
        let (_directory, server) = server_with_fixture();
        let response = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "orion_get_source",
                    "arguments": {
                        "space_id": "space-alpha",
                        "source_id": "source-lecture",
                        "max_chars": 1000
                    }
                }
            }))
            .expect("response");
        let source = &response["result"]["structuredContent"]["source"];
        assert_eq!(source["textTruncated"], true);
        assert_eq!(
            source["text"].as_str().map(|text| text.chars().count()),
            Some(1000)
        );
    }

    #[test]
    fn note_write_tools_create_edit_and_delete_inside_one_space() {
        let (_directory, server) = server_with_fixture();
        let created = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "orion_create_note",
                    "arguments": {
                        "space_id": "space-alpha",
                        "title": "MCP field notes",
                        "body": "A complete note written through MCP.",
                        "tags": ["mcp", "research"],
                        "status": "ready"
                    }
                }
            }))
            .expect("create response");
        assert_eq!(created["result"]["isError"], false);
        let note_id = created["result"]["structuredContent"]["note"]["id"]
            .as_str()
            .expect("created note id")
            .to_string();
        assert_eq!(
            created["result"]["structuredContent"]["citation"],
            format!("[MCP field notes](orion://open?space_id=space-alpha&note_id={note_id})")
        );

        let updated = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "orion_update_note",
                    "arguments": {
                        "space_id": "space-alpha",
                        "note_id": note_id,
                        "title": "Edited field notes",
                        "body": "Claude can edit the complete body directly.",
                        "pinned": true
                    }
                }
            }))
            .expect("update response");
        assert_eq!(updated["result"]["isError"], false);
        assert_eq!(
            updated["result"]["structuredContent"]["note"]["title"],
            "Edited field notes"
        );
        assert_eq!(
            updated["result"]["structuredContent"]["note"]["pinned"],
            true
        );

        let read = read_vault(&server.vault_path).expect("read updated vault");
        let note = require_space(&read, "space-alpha")
            .expect("space")
            .notes
            .iter()
            .find(|note| note.id == note_id)
            .expect("written note");
        assert_eq!(note.body, "Claude can edit the complete body directly.");

        let deleted = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "orion_delete_note",
                    "arguments": {
                        "space_id": "space-alpha",
                        "note_id": note_id
                    }
                }
            }))
            .expect("delete response");
        assert_eq!(deleted["result"]["structuredContent"]["deleted"], true);
        let read = read_vault(&server.vault_path).expect("read deleted vault");
        assert!(require_space(&read, "space-alpha")
            .expect("space")
            .notes
            .iter()
            .all(|note| note.id != note_id));
        assert_eq!(
            require_space(&read, "space-private")
                .expect("private space")
                .notes
                .len(),
            1
        );
    }

    #[test]
    fn read_results_include_clickable_orion_note_citations() {
        let (_directory, server) = server_with_fixture();
        let response = server
            .handle_request(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "orion_get_note",
                    "arguments": {
                        "space_id": "space-alpha",
                        "note_id": "note-comte"
                    }
                }
            }))
            .expect("response");
        assert_eq!(
            response["result"]["structuredContent"]["note"]["orionUrl"],
            "orion://open?space_id=space-alpha&note_id=note-comte"
        );
        assert_eq!(
            response["result"]["structuredContent"]["note"]["citation"],
            "[Auguste Comte](orion://open?space_id=space-alpha&note_id=note-comte)"
        );
    }

    #[test]
    fn delete_tool_cleans_links_sources_and_orphaned_concepts() {
        let (_directory, server) = server_with_fixture();
        let created = server
            .call_tool(
                "orion_create_note",
                json!({
                    "space_id": "space-alpha",
                    "title": "Linked note",
                    "body": "See [Comte](orion-note://note-comte) and [positivism](orion-concept://concept-comte)."
                })
                .as_object()
                .expect("arguments"),
            )
            .expect("create note");
        let linked_note_id = created["note"]["id"].as_str().expect("note id").to_string();

        server
            .call_tool(
                "orion_delete_note",
                json!({
                    "space_id": "space-alpha",
                    "note_id": "note-comte"
                })
                .as_object()
                .expect("arguments"),
            )
            .expect("delete note");
        let vault = read_vault(&server.vault_path).expect("read vault");
        let space = require_space(&vault, "space-alpha").expect("space");
        assert!(space.concepts.is_empty());
        assert!(space.sources[0].note_ids.is_empty());
        assert_eq!(
            space
                .notes
                .iter()
                .find(|note| note.id == linked_note_id)
                .expect("linked note")
                .body,
            "See Comte and positivism."
        );
    }

    #[test]
    fn invalid_vault_schema_is_rejected() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("vault.json");
        let mut fixture = fixture_vault();
        fixture["schemaVersion"] = json!(99);
        fs::write(
            &path,
            serde_json::to_vec(&fixture).expect("serialize fixture"),
        )
        .expect("write fixture");
        let error = read_vault(&path).expect_err("schema should be rejected");
        assert!(error.message.contains("Unsupported Orion vault schema"));
    }
}
