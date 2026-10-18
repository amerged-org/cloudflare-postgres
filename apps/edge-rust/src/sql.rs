// SPDX-License-Identifier: Apache-2.0
//! HTTP SQL: `POST /sql` in the wire format of the Neon serverless driver's HTTP query mode
//! (`neon()`, `transaction()`), as the TypeScript Edge serves it (`apps/edge/src/sql.ts`). This is
//! the pure part: what a request says, and what is forwarded to the gateway and answered. The
//! Worker (`sql_host.rs`) admits it as a WebSocket connection is admitted and forwards it once.
//!
//! The password of the connection string goes to the gateway in the request body only; it is
//! never logged, and neither are statements or parameters.
use crate::policy::Failure;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_native_protocol::{constant, valid_pattern, valid_role};
use serde::Serialize;
use serde_json::Value;

/// The largest body the gateway accepts (`MAX_REQUEST_BYTES` in the gateway's sql.rs).
pub fn max_request_bytes() -> usize {
    constant("MAX_SQL_REQUEST_BYTES") as usize
}
/// The most statements of one transaction (`MAX_STATEMENTS` in the gateway's sql.rs).
pub fn max_statements() -> usize {
    constant("MAX_SQL_STATEMENTS") as usize
}
const ISOLATION_LEVELS: [&str; 4] = [
    "ReadUncommitted",
    "ReadCommitted",
    "RepeatableRead",
    "Serializable",
];

/// The answer to a request that failed: a 400 with the SQLSTATE in `code`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SqlFailure {
    pub message: String,
    pub code: String,
    pub severity: &'static str,
}
impl SqlFailure {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
            severity: "ERROR",
        }
    }
    pub fn invalid() -> Self {
        Self::new("08P01", "invalid HTTP SQL request")
    }
    pub fn authentication_failed() -> Self {
        Self {
            severity: "FATAL",
            ..Self::new("28P01", "password authentication failed")
        }
    }
    pub fn too_large() -> Self {
        Self::new("54000", "request is too large")
    }
    pub fn gateway() -> Self {
        Self::new("08006", "gateway connection failed")
    }
    /// The Edge never retries a forwarded request: an answer that does not come from the gateway
    /// is reported as an unknown outcome.
    pub fn unknown_outcome() -> Self {
        Self::new(
            "08007",
            "the gateway's answer was lost; the request's outcome is unknown and it was not retried",
        )
    }
}
impl From<Failure> for SqlFailure {
    /// An admission refusal is answered as an unknown database or role is: as a wrong password.
    fn from(failure: Failure) -> Self {
        if failure.decoy {
            Self::authentication_failed()
        } else {
            Self::new(&failure.sqlstate, &failure.message)
        }
    }
}

/// The database, role and password of `Neon-Connection-String`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connection {
    pub database: String,
    pub user: String,
    pub password: String,
}
/// `decodeURIComponent`: a malformed escape, or bytes that are no UTF-8, are refused.
fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}
/// The connection string's host and options are not used.
pub fn connection(header: Option<&str>) -> Result<Connection, SqlFailure> {
    let url = url::Url::parse(header.unwrap_or("")).map_err(|_| SqlFailure::invalid())?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(SqlFailure::invalid());
    }
    let decode = |text: &str| decode_component(text).ok_or_else(SqlFailure::invalid);
    let database = decode(url.path().get(1..).unwrap_or(""))?;
    let user = decode(url.username())?;
    let password = decode(url.password().unwrap_or(""))?;
    if !valid_pattern("database", &database) {
        return Err(SqlFailure::new("3D000", "database does not exist"));
    }
    if !valid_role(&user) {
        return Err(SqlFailure::new("28P01", "authentication failed"));
    }
    if password.is_empty() {
        return Err(SqlFailure::authentication_failed());
    }
    Ok(Connection {
        database,
        user,
        password,
    })
}

/// A batch's transaction characteristics, forwarded as the driver sent them.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Transaction {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferrable: Option<bool>,
}
/// What the driver always sends, and a batch's transaction characteristics. `header` reads a
/// header of the request by name.
pub fn transaction(header: impl Fn(&str) -> Option<String>) -> Result<Transaction, SqlFailure> {
    let true_text = |name: &str| header(name).is_some_and(|value| value.to_lowercase() == "true");
    if !true_text("Neon-Raw-Text-Output") || !true_text("Neon-Array-Mode") {
        return Err(SqlFailure::new(
            "0A000",
            "only raw text results in array mode are supported",
        ));
    }
    if header("Authorization").is_some() {
        return Err(SqlFailure::new(
            "0A000",
            "authorization tokens are not supported",
        ));
    }
    let mut characteristics = Transaction::default();
    if let Some(isolation) = header("Neon-Batch-Isolation-Level") {
        if !ISOLATION_LEVELS.contains(&isolation.as_str()) {
            return Err(SqlFailure::invalid());
        }
        characteristics.isolation = Some(isolation);
    }
    let flag = |name: &str| match header(name).as_deref() {
        None => Ok(None),
        Some("true") => Ok(Some(true)),
        Some("false") => Ok(Some(false)),
        Some(_) => Err(SqlFailure::invalid()),
    };
    characteristics.read_only = flag("Neon-Batch-Read-Only")?;
    characteristics.deferrable = flag("Neon-Batch-Deferrable")?;
    Ok(characteristics)
}

/// The body, as text: the gateway's bound has been kept while reading it.
pub fn body_text(bytes: &[u8]) -> Result<String, SqlFailure> {
    let text = std::str::from_utf8(bytes).map_err(|_| SqlFailure::invalid())?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text).to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Statement {
    pub query: String,
    pub params: Vec<Option<String>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statements {
    pub queries: Vec<Statement>,
    /// A transaction (`{queries}`), not a single statement.
    pub batch: bool,
}
/// `String(number)`, the text of a JSON number as JavaScript writes it.
pub fn number_text(number: f64) -> String {
    if number == 0.0 {
        return "0".into();
    }
    if !number.is_finite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .into();
    }
    // The shortest digits that read back as the number, and the exponent of the first one.
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("scientific notation");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    let mut text = if number < 0.0 { "-" } else { "" }.to_string();
    if k <= n && n <= 21 {
        text.push_str(&digits);
        text.push_str(&"0".repeat((n - k) as usize));
    } else if 0 < n && n <= 21 {
        text.push_str(&digits[..n as usize]);
        text.push('.');
        text.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        text.push_str("0.");
        text.push_str(&"0".repeat((-n) as usize));
        text.push_str(&digits);
    } else {
        text.push_str(&digits[..1]);
        if k > 1 {
            text.push('.');
            text.push_str(&digits[1..]);
        }
        text.push('e');
        text.push(if n - 1 < 0 { '-' } else { '+' });
        text.push_str(&(n - 1).abs().to_string());
    }
    text
}
fn statement(value: &Value) -> Result<Statement, SqlFailure> {
    let object = value.as_object().ok_or_else(SqlFailure::invalid)?;
    let query = object
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(SqlFailure::invalid)?;
    if !object.keys().all(|key| key == "query" || key == "params") {
        return Err(SqlFailure::invalid());
    }
    let params = match object.get("params") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(params)) => params
            .iter()
            .map(|param| match param {
                Value::Null => Ok(None),
                Value::String(text) => Ok(Some(text.clone())),
                // The driver sends text or null; other JSON scalars are sent as their text.
                Value::Number(number) => Ok(Some(number_text(
                    number.as_f64().ok_or_else(SqlFailure::invalid)?,
                ))),
                Value::Bool(flag) => Ok(Some(flag.to_string())),
                _ => Err(SqlFailure::invalid()),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(SqlFailure::invalid()),
    };
    Ok(Statement {
        query: query.into(),
        params,
    })
}
/// One statement (`{query, params}`) or a transaction (`{queries}`).
pub fn statements(text: &str) -> Result<Statements, SqlFailure> {
    let Value::Object(body) = serde_json::from_str(text).map_err(|_| SqlFailure::invalid())? else {
        return Err(SqlFailure::invalid());
    };
    let Some(queries) = body.get("queries") else {
        return Ok(Statements {
            queries: vec![statement(&Value::Object(body))?],
            batch: false,
        });
    };
    match queries {
        Value::Array(queries) if body.len() == 1 && queries.len() <= max_statements() => {
            Ok(Statements {
                queries: queries.iter().map(statement).collect::<Result<_, _>>()?,
                batch: true,
            })
        }
        _ => Err(SqlFailure::invalid()),
    }
}

#[derive(Serialize)]
struct Forward<'a> {
    password: String,
    queries: &'a [Statement],
    #[serde(skip_serializing_if = "Option::is_none")]
    transaction: Option<&'a Transaction>,
}
/// The request the gateway receives: the password as base64url, the statements, and a
/// transaction's characteristics.
pub fn forward_body(
    password: &str,
    statements: &Statements,
    characteristics: &Transaction,
) -> Result<String, SqlFailure> {
    let body = serde_json::to_string(&Forward {
        password: URL_SAFE_NO_PAD.encode(password.as_bytes()),
        queries: &statements.queries,
        transaction: statements.batch.then_some(characteristics),
    })
    .map_err(|_| SqlFailure::gateway())?;
    if body.len() > max_request_bytes() {
        return Err(SqlFailure::too_large());
    }
    Ok(body)
}

/// Whether a response of the gateway says it is JSON.
pub fn is_json(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| value.starts_with("application/json"))
}
/// Whether the gateway's 400 is an answer of its own: a JSON object with a `code`.
pub fn is_gateway_error(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .is_some_and(|answer| answer.get("code").is_some_and(Value::is_string))
}
