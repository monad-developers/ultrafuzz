use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use ultrafuzz_core::{AttemptId, BackendKind, ModelProfileId, NodeId, RunId, StrategyId};

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_REPLAY_RECORD_LIMIT: usize = 10_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogStream {
    Stdout,
    Stderr,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "event_type", content = "payload")]
pub enum RunEvent {
    RunStarted,
    RunRestarted {
        source_run_id: RunId,
    },
    RunFinished,
    RunFailed {
        error: String,
    },
    NodeReady {
        node_id: NodeId,
    },
    NodeStarted {
        node_id: NodeId,
    },
    NodeFinished {
        node_id: NodeId,
    },
    NodeFailed {
        node_id: NodeId,
        error: String,
    },
    NodeSkipped {
        node_id: NodeId,
        reason: String,
    },
    NodeTimedOut {
        node_id: NodeId,
    },
    NodeReused {
        node_id: NodeId,
    },
    AttemptStarted {
        attempt_id: AttemptId,
        node_id: NodeId,
        strategy: StrategyId,
        attempt_index: usize,
        model_id: ModelProfileId,
        model_index: usize,
        loop_index: usize,
    },
    AttemptFinished {
        attempt_id: AttemptId,
        node_id: NodeId,
        model_id: ModelProfileId,
    },
    AttemptFailed {
        attempt_id: AttemptId,
        node_id: NodeId,
        model_id: ModelProfileId,
        error: String,
    },
    WorkspaceCreated {
        node_id: NodeId,
        path: PathBuf,
    },
    WorkspaceCleaned {
        node_id: NodeId,
    },
    PromptRendered {
        node_id: NodeId,
        path: PathBuf,
    },
    BackendStarted {
        node_id: NodeId,
        backend: BackendKind,
        model_id: ModelProfileId,
        model: Option<String>,
    },
    BackendFinished {
        node_id: NodeId,
        backend: BackendKind,
        model_id: ModelProfileId,
        model: Option<String>,
    },
    BackendFailed {
        node_id: NodeId,
        backend: BackendKind,
        model_id: ModelProfileId,
        model: Option<String>,
        error: String,
    },
    LogLine {
        node_id: NodeId,
        stream: LogStream,
        line: String,
    },
    ArtifactCreated {
        node_id: NodeId,
        path: PathBuf,
    },
    FindingCreated {
        node_id: NodeId,
        path: PathBuf,
    },
    PatchCreated {
        node_id: NodeId,
        path: PathBuf,
    },
    TriageUpdated {
        finding_id: String,
    },
}

impl RunEvent {
    pub fn node_id(&self) -> Option<NodeId> {
        match self {
            Self::NodeReady { node_id }
            | Self::NodeStarted { node_id }
            | Self::NodeFinished { node_id }
            | Self::NodeFailed { node_id, .. }
            | Self::NodeSkipped { node_id, .. }
            | Self::NodeTimedOut { node_id }
            | Self::NodeReused { node_id }
            | Self::AttemptStarted { node_id, .. }
            | Self::AttemptFinished { node_id, .. }
            | Self::AttemptFailed { node_id, .. }
            | Self::WorkspaceCreated { node_id, .. }
            | Self::WorkspaceCleaned { node_id }
            | Self::PromptRendered { node_id, .. }
            | Self::BackendStarted { node_id, .. }
            | Self::BackendFinished { node_id, .. }
            | Self::BackendFailed { node_id, .. }
            | Self::LogLine { node_id, .. }
            | Self::ArtifactCreated { node_id, .. }
            | Self::FindingCreated { node_id, .. }
            | Self::PatchCreated { node_id, .. } => Some(node_id.clone()),
            Self::RunStarted
            | Self::RunRestarted { .. }
            | Self::RunFinished
            | Self::RunFailed { .. }
            | Self::TriageUpdated { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventRecord {
    pub timestamp: String,
    pub run_id: RunId,
    pub node_id: Option<NodeId>,
    pub event_type: String,
    pub payload: Value,
}

impl EventRecord {
    pub fn from_event(run_id: RunId, event: RunEvent) -> anyhow::Result<Self> {
        let node_id = event.node_id();
        let event_value = serde_json::to_value(event)?;
        let (event_type, payload) = event_type_and_payload(event_value);
        Ok(Self {
            timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            run_id,
            node_id,
            event_type,
            payload: redact_value(payload),
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EventReplay {
    pub records: Vec<EventRecord>,
    pub malformed_records: usize,
    pub truncated_records: usize,
}

impl EventReplay {
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    fn push_record(&mut self, record: EventRecord, record_limit: usize) {
        if self.records.len() < record_limit {
            self.records.push(record);
        } else {
            self.truncated_records = self.truncated_records.saturating_add(1);
        }
    }
}

pub trait EventSink: Send + Sync {
    fn emit(&self, record: EventRecord) -> anyhow::Result<()>;
}

pub fn emit_event(sink: &dyn EventSink, run_id: &RunId, event: RunEvent) -> anyhow::Result<()> {
    sink.emit(EventRecord::from_event(run_id.clone(), event)?)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NullEventSink;

impl EventSink for NullEventSink {
    fn emit(&self, _record: EventRecord) -> anyhow::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
pub struct JsonlEventSink {
    path: PathBuf,
    lock: Mutex<()>,
}

impl JsonlEventSink {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl EventSink for JsonlEventSink {
    fn emit(&self, mut record: EventRecord) -> anyhow::Result<()> {
        record.payload = redact_value(record.payload);
        let _guard = self.lock.lock().expect("event sink mutex poisoned");
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        serde_json::to_writer(&mut file, &record)?;
        file.write_all(b"\n")?;
        file.flush()?;
        Ok(())
    }
}

#[derive(Debug)]
pub struct SqliteEventSink {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SqliteEventSink {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connection(&self) -> anyhow::Result<Connection> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&self.path)?;
        initialize_sqlite(&connection)?;
        Ok(connection)
    }
}

impl EventSink for SqliteEventSink {
    fn emit(&self, mut record: EventRecord) -> anyhow::Result<()> {
        record.payload = redact_value(record.payload);
        let _guard = self.lock.lock().expect("event sink mutex poisoned");
        let connection = self.connection()?;
        let payload = serde_json::to_string(&record.payload)?;
        let node_id = record.node_id.as_ref().map(ToString::to_string);
        connection.execute(
            "insert into events (timestamp, run_id, node_id, event_type, payload)
             values (?1, ?2, ?3, ?4, ?5)",
            params![
                record.timestamp,
                record.run_id.to_string(),
                node_id,
                record.event_type,
                payload
            ],
        )?;
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct CompositeEventSink {
    sinks: Vec<Arc<dyn EventSink>>,
}

impl CompositeEventSink {
    pub fn new(sinks: Vec<Arc<dyn EventSink>>) -> Self {
        Self { sinks }
    }

    pub fn push(&mut self, sink: Arc<dyn EventSink>) {
        self.sinks.push(sink);
    }
}

impl EventSink for CompositeEventSink {
    fn emit(&self, record: EventRecord) -> anyhow::Result<()> {
        for sink in &self.sinks {
            sink.emit(record.clone())?;
        }
        Ok(())
    }
}

pub fn replay_jsonl(path: impl AsRef<Path>) -> anyhow::Result<Vec<EventRecord>> {
    Ok(replay_jsonl_report(path)?.records)
}

pub fn replay_jsonl_report(path: impl AsRef<Path>) -> anyhow::Result<EventReplay> {
    replay_jsonl_report_with_limit(path, DEFAULT_REPLAY_RECORD_LIMIT)
}

pub fn replay_jsonl_report_with_limit(
    path: impl AsRef<Path>,
    record_limit: usize,
) -> anyhow::Result<EventReplay> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(EventReplay::default());
    }

    let file = fs::File::open(path)?;
    let mut replay = EventReplay::default();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<EventRecord>(&line) {
            Ok(record) => replay.push_record(record, record_limit),
            Err(_) => replay.malformed_records = replay.malformed_records.saturating_add(1),
        }
    }
    Ok(replay)
}

pub fn replay_sqlite(path: impl AsRef<Path>) -> anyhow::Result<Vec<EventRecord>> {
    Ok(replay_sqlite_report(path)?.records)
}

pub fn replay_sqlite_report(path: impl AsRef<Path>) -> anyhow::Result<EventReplay> {
    replay_sqlite_report_with_limit(path, DEFAULT_REPLAY_RECORD_LIMIT)
}

pub fn replay_sqlite_report_with_limit(
    path: impl AsRef<Path>,
    record_limit: usize,
) -> anyhow::Result<EventReplay> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(EventReplay::default());
    }
    let connection = Connection::open(path)?;
    configure_sqlite_connection(&connection)?;
    let has_events_table: bool = connection.query_row(
        "select exists(
            select 1 from sqlite_master where type = 'table' and name = 'events'
        )",
        [],
        |row| row.get(0),
    )?;
    if !has_events_table {
        return Ok(EventReplay::default());
    }
    let mut statement = connection.prepare(
        "select timestamp, run_id, node_id, event_type, payload from events order by id asc",
    )?;
    let mut rows = statement.query([])?;
    let mut replay = EventReplay::default();
    while let Some(row) = rows.next()? {
        match event_record_from_sqlite_row(row) {
            Ok(record) => replay.push_record(record, record_limit),
            Err(_) => replay.malformed_records = replay.malformed_records.saturating_add(1),
        }
    }

    Ok(replay)
}

fn event_record_from_sqlite_row(row: &rusqlite::Row<'_>) -> Result<EventRecord, String> {
    let timestamp: String = row.get(0).map_err(|error| error.to_string())?;
    let run_id = RunId::try_new(row.get::<_, String>(1).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let node_id = row
        .get::<_, Option<String>>(2)
        .map_err(|error| error.to_string())?
        .map(NodeId::try_new)
        .transpose()
        .map_err(|error| error.to_string())?;
    let event_type: String = row.get(3).map_err(|error| error.to_string())?;
    let payload: String = row.get(4).map_err(|error| error.to_string())?;
    let payload = serde_json::from_str(&payload).map_err(|error| error.to_string())?;

    Ok(EventRecord {
        timestamp,
        run_id,
        node_id,
        event_type,
        payload,
    })
}

fn initialize_sqlite(connection: &Connection) -> anyhow::Result<()> {
    configure_sqlite_connection(connection)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.execute_batch(
        "create table if not exists events (
            id integer primary key autoincrement,
            timestamp text not null,
            run_id text not null,
            node_id text,
            event_type text not null,
            payload text not null
        );
        create index if not exists idx_events_run_id on events(run_id);
        create index if not exists idx_events_node_id on events(node_id);
        create index if not exists idx_events_event_type on events(event_type);",
    )?;
    Ok(())
}

fn configure_sqlite_connection(connection: &Connection) -> anyhow::Result<()> {
    connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    Ok(())
}

fn event_type_and_payload(value: Value) -> (String, Value) {
    let Value::Object(mut object) = value else {
        return ("unknown".to_owned(), Value::Object(Map::new()));
    };

    let event_type = object
        .remove("event_type")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    let payload = object
        .remove("payload")
        .unwrap_or_else(|| Value::Object(Map::new()));
    (event_type, payload)
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    if is_sensitive_key(&key) {
                        (key, Value::String("<redacted>".to_owned()))
                    } else {
                        (key, redact_value(value))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
        Value::String(value) if is_sensitive_value(&value) => {
            Value::String("<redacted>".to_owned())
        }
        value => value,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("api_key")
        || key.contains("apikey")
        || key.contains("credential")
        || key.contains("private_key")
}

fn is_sensitive_value(value: &str) -> bool {
    value.contains("sk-")
        || value.contains("BEGIN PRIVATE KEY")
        || value.contains("BEGIN RSA PRIVATE KEY")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replays_jsonl_events() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.jsonl");
        let sink = JsonlEventSink::new(&path);

        emit_event(
            &sink,
            &RunId::from("run"),
            RunEvent::NodeStarted {
                node_id: NodeId::from("node"),
            },
        )
        .unwrap();

        let records = replay_jsonl(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].event_type, "node-started");
        assert_eq!(records[0].node_id, Some(NodeId::from("node")));
    }

    #[test]
    fn replay_jsonl_counts_malformed_and_truncated_records() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.jsonl");
        fs::write(
            &path,
            [
                r#"{"timestamp":"2026-06-22T00:00:00Z","run_id":"run","node_id":null,"event_type":"run-started","payload":{}}"#,
                "not json",
                r#"{"timestamp":"2026-06-22T00:00:01Z","run_id":"run","node_id":"node","event_type":"node-started","payload":{}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let replay = replay_jsonl_report_with_limit(&path, 1).unwrap();

        assert_eq!(replay.records.len(), 1);
        assert_eq!(replay.records[0].event_type, "run-started");
        assert_eq!(replay.malformed_records, 1);
        assert_eq!(replay.truncated_records, 1);
    }

    #[test]
    fn writes_and_replays_sqlite_events() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.sqlite");
        let sink = SqliteEventSink::new(&path);

        emit_event(&sink, &RunId::from("run"), RunEvent::RunStarted).unwrap();
        emit_event(&sink, &RunId::from("run"), RunEvent::RunFinished).unwrap();

        let records = replay_sqlite(&path).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].event_type, "run-started");
        assert_eq!(records[1].event_type, "run-finished");
    }

    #[test]
    fn replay_sqlite_counts_malformed_and_truncated_records() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.sqlite");
        let connection = Connection::open(&path).unwrap();
        initialize_sqlite(&connection).unwrap();
        for (event_type, payload) in [
            ("run-started", "{}"),
            ("bad-payload", "not json"),
            ("run-finished", "{}"),
        ] {
            connection
                .execute(
                    "insert into events (timestamp, run_id, node_id, event_type, payload)
                     values (?1, ?2, ?3, ?4, ?5)",
                    params![
                        "2026-06-22T00:00:00Z",
                        "run",
                        Option::<String>::None,
                        event_type,
                        payload
                    ],
                )
                .unwrap();
        }

        let replay = replay_sqlite_report_with_limit(&path, 1).unwrap();

        assert_eq!(replay.records.len(), 1);
        assert_eq!(replay.records[0].event_type, "run-started");
        assert_eq!(replay.malformed_records, 1);
        assert_eq!(replay.truncated_records, 1);
    }

    #[test]
    fn sqlite_event_sink_waits_for_transient_write_locks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.sqlite");
        let lock_holder = Connection::open(&path).unwrap();
        initialize_sqlite(&lock_holder).unwrap();
        lock_holder.execute_batch("begin immediate").unwrap();

        let sink = SqliteEventSink::new(&path);
        let handle = std::thread::spawn(move || {
            emit_event(&sink, &RunId::from("run"), RunEvent::RunFinished)
        });

        std::thread::sleep(Duration::from_millis(100));
        lock_holder.execute_batch("commit").unwrap();
        handle.join().unwrap().unwrap();

        let records = replay_sqlite(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].event_type, "run-finished");
    }

    #[test]
    fn replay_sqlite_does_not_create_missing_schema() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.sqlite");
        Connection::open(&path).unwrap();

        let records = replay_sqlite(&path).unwrap();

        assert!(records.is_empty());
        let connection = Connection::open(&path).unwrap();
        let has_events_table: bool = connection
            .query_row(
                "select exists(
                    select 1 from sqlite_master where type = 'table' and name = 'events'
                )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!has_events_table);
    }

    #[test]
    fn redacts_sensitive_payloads_before_persisting() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("events.jsonl");
        let sink = JsonlEventSink::new(&path);

        emit_event(
            &sink,
            &RunId::from("run"),
            RunEvent::LogLine {
                node_id: NodeId::from("node"),
                stream: LogStream::Stdout,
                line: "OPENAI_API_KEY=sk-secret".to_owned(),
            },
        )
        .unwrap();

        let raw = fs::read_to_string(path).unwrap();
        assert!(!raw.contains("sk-secret"));
        assert!(raw.contains("<redacted>"));
    }
}
