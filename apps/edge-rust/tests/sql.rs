// SPDX-License-Identifier: Apache-2.0
use pgcf_edge_rust::sql::{
    self, SqlFailure, Statement, Statements, Transaction, max_request_bytes, max_statements,
};
use serde_json::{Value, json};
use std::collections::HashMap;

fn vectors() -> Value {
    let all: Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/native/conformance.generated.json"
    ))
    .unwrap();
    all["edge"]["sql"].clone()
}
/// A result in the shape the TypeScript Edge's vectors record it.
fn outcome(result: Result<Value, SqlFailure>) -> Value {
    match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(failure) => json!({
            "ok": false,
            "code": failure.code,
            "message": failure.message,
            "severity": failure.severity,
        }),
    }
}
fn statements_value(statements: Statements) -> Value {
    json!({"queries": statements.queries, "batch": statements.batch})
}

#[test]
fn the_typescript_edge_reads_a_connection_string_as_the_rust_edge_does() {
    for row in vectors()["connections"].as_array().unwrap() {
        let actual = sql::connection(row["header"].as_str()).map(|connection| {
            json!({
                "database": connection.database,
                "user": connection.user,
                "password": connection.password,
            })
        });
        assert_eq!(outcome(actual), row["expected"], "{row}");
    }
}

#[test]
fn the_typescript_edge_reads_the_transaction_headers_as_the_rust_edge_does() {
    for row in vectors()["transactions"].as_array().unwrap() {
        let headers: HashMap<String, String> = row["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| (name.to_lowercase(), value.as_str().unwrap().into()))
            .collect();
        let actual = sql::transaction(|name| headers.get(&name.to_lowercase()).cloned())
            .map(|transaction| serde_json::to_value(transaction).unwrap());
        assert_eq!(outcome(actual), row["expected"], "{row}");
    }
}

#[test]
fn the_typescript_edge_reads_a_body_as_the_rust_edge_does() {
    for row in vectors()["bodies"].as_array().unwrap() {
        let actual = sql::statements(row["text"].as_str().unwrap()).map(statements_value);
        assert_eq!(outcome(actual), row["expected"], "{}", row["text"]);
    }
    for row in vectors()["decoded"].as_array().unwrap() {
        let bytes: Vec<u8> = row["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| byte.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(
            outcome(sql::body_text(&bytes).map(Value::from)),
            row["expected"],
            "{row}"
        );
    }
}

#[test]
fn the_typescript_edge_builds_the_request_to_the_gateway_as_the_rust_edge_does() {
    for row in vectors()["forwards"].as_array().unwrap() {
        let transaction: Transaction = Transaction {
            isolation: row["transaction"]["isolation"].as_str().map(Into::into),
            read_only: row["transaction"]["read_only"].as_bool(),
            deferrable: row["transaction"]["deferrable"].as_bool(),
        };
        let statements = sql::statements(row["text"].as_str().unwrap()).unwrap();
        let actual =
            sql::forward_body(row["password"].as_str().unwrap(), &statements, &transaction)
                .map(Value::from);
        assert_eq!(outcome(actual), row["expected"], "{row}");
    }
}

#[test]
fn a_request_to_the_gateway_is_bounded_as_the_gateway_bounds_it() {
    let statement = |query: String| Statements {
        queries: vec![Statement {
            query,
            params: Vec::new(),
        }],
        batch: false,
    };
    let framing = sql::forward_body("p", &statement(String::new()), &Transaction::default())
        .unwrap()
        .len();
    let fits = statement("x".repeat(max_request_bytes() - framing));
    assert_eq!(
        sql::forward_body("p", &fits, &Transaction::default())
            .unwrap()
            .len(),
        max_request_bytes()
    );
    let over = statement("x".repeat(max_request_bytes() - framing + 1));
    assert_eq!(
        sql::forward_body("p", &over, &Transaction::default()).unwrap_err(),
        SqlFailure::too_large()
    );
    assert_eq!(max_statements(), 256);
}

#[test]
fn only_a_json_answer_of_the_gateway_with_a_code_is_passed_through() {
    assert!(sql::is_json(Some("application/json")));
    assert!(sql::is_json(Some("application/json; charset=utf-8")));
    assert!(!sql::is_json(Some("text/plain")));
    assert!(!sql::is_json(Some("Application/JSON")));
    assert!(!sql::is_json(None));
    assert!(sql::is_gateway_error(
        r#"{"message":"m","code":"42P01","severity":"ERROR"}"#
    ));
    for text in [
        "",
        "[]",
        "null",
        r#"{"code":42}"#,
        r#"{"message":"m"}"#,
        "{",
    ] {
        assert!(!sql::is_gateway_error(text), "{text}");
    }
}
