// SPDX-License-Identifier: Apache-2.0
//! What the agent may say about a failure in its log. An error's own text can carry an
//! address, a role, a path or a server's own words, so the log names a failure by its class and,
//! where one exists, a status code, never by its message.
use crate::Error;

pub mod boot_report;

/// The class of `error` as a short snake-case code: its kind (`postgres_28p01`, `http_connect`,
/// `io_connection_refused`, `deadline_exceeded`), or a fixed phrase the agent wrote itself
/// (`cluster_uid_changed`), or `other`.
pub fn error_code(error: &Error) -> String {
    if error
        .downcast_ref::<tokio::time::error::Elapsed>()
        .is_some()
    {
        return "deadline_exceeded".into();
    }
    if let Some(error) = error.downcast_ref::<tokio_postgres::Error>() {
        return postgres_code(error);
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return http_code(error).into();
    }
    if let Some(error) = error.downcast_ref::<std::io::Error>() {
        return format!("io_{}", snake(&format!("{:?}", error.kind())));
    }
    if let Some(error) = error.downcast_ref::<serde_json::Error>() {
        return match error.classify() {
            serde_json::error::Category::Io => "json_io",
            serde_json::error::Category::Syntax => "json_syntax",
            serde_json::error::Category::Data => "json_data",
            serde_json::error::Category::Eof => "json_eof",
        }
        .into();
    }
    phrase(&error.to_string()).unwrap_or_else(|| "other".into())
}

/// A database error's SQLSTATE (five characters, never free text), or where a connection failed.
fn postgres_code(error: &tokio_postgres::Error) -> String {
    if let Some(state) = error.code() {
        return format!("postgres_{}", state.code().to_ascii_lowercase());
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return format!("postgres_io_{}", snake(&format!("{:?}", io.kind())));
        }
        source = cause.source();
    }
    if error.is_closed() {
        "postgres_closed".into()
    } else {
        "postgres".into()
    }
}

/// The stage of an HTTP request that failed; the URL it carries is never read.
fn http_code(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "http_timeout"
    } else if error.is_connect() {
        "http_connect"
    } else if error.is_redirect() {
        "http_redirect"
    } else if error.is_decode() {
        "http_decode"
    } else if error.is_body() {
        "http_body"
    } else if error.is_builder() {
        "http_builder"
    } else if error.is_status() {
        "http_status"
    } else {
        "http_request"
    }
}

/// `ConnectionRefused` as `connection_refused`.
fn snake(camel: &str) -> String {
    let mut out = String::new();
    for (index, c) in camel.chars().enumerate() {
        if c.is_ascii_uppercase() && index > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// A message the agent wrote itself is a short phrase of plain words: letters and single
/// spaces, no digit, no word longer than a name. An address, a number, a path, a token or a
/// password does not look like one and is not kept.
fn phrase(message: &str) -> Option<String> {
    let words: Vec<&str> = message.split(' ').collect();
    let plain = !message.is_empty()
        && message.len() <= 80
        && words.len() <= 12
        && words
            .iter()
            .all(|w| (1..=20).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_alphabetic()));
    plain.then(|| message.to_ascii_lowercase().replace(' ', "_"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(error: impl Into<Error>) -> String {
        error_code(&error.into())
    }
    /// Nothing a log line must not carry: an address, a long opaque token, a secret.
    fn clean(code: &str) -> bool {
        let dotted_quad = code
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .any(|part| {
                let numbers: Vec<_> = part.split('.').collect();
                numbers.len() == 4
                    && numbers
                        .iter()
                        .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            });
        !code.is_empty()
            && code.len() <= 80
            && code
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            && code.split('_').all(|word| word.len() <= 24)
            && !dotted_quad
    }

    #[test]
    fn typed_failures_are_named_by_their_kind_and_status_never_their_text() {
        assert_eq!(
            code(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "10.0.0.7:5432 refused the connection"
            )),
            "io_connection_refused"
        );
        assert_eq!(
            code(serde_json::from_str::<serde_json::Value>("{").unwrap_err()),
            "json_eof"
        );
        assert_eq!(
            code(serde_json::from_str::<u8>("\"x\"").unwrap_err()),
            "json_data"
        );
    }

    #[tokio::test]
    async fn network_and_database_failures_never_carry_the_address_they_failed_at() {
        let elapsed = tokio::time::timeout(
            std::time::Duration::from_millis(1),
            std::future::pending::<()>(),
        )
        .await
        .unwrap_err();
        assert_eq!(code(elapsed), "deadline_exceeded");
        // The listener is closed: the client error names the address in its text.
        let refused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = refused.local_addr().unwrap();
        drop(refused);
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .tls_certs_only(Vec::new())
            .no_proxy()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap()
            .get(format!("http://{address}/secret-path"))
            .send()
            .await
            .unwrap_err();
        assert!(http.to_string().contains("127.0.0.1"), "the text names it");
        let named = code(http);
        assert_eq!(named, "http_connect");
        let postgres = tokio_postgres::Config::new()
            .host("127.0.0.1")
            .port(address.port())
            .user("app")
            .password("hunter2-opaque-credential")
            .connect(tokio_postgres::NoTls)
            .await
            .map(|_| ())
            .unwrap_err();
        let named = code(postgres);
        assert_eq!(named, "postgres_io_connection_refused");
    }

    #[test]
    fn an_agent_phrase_is_kept_and_anything_else_is_other() {
        assert_eq!(code("Cluster UID changed"), "cluster_uid_changed");
        assert_eq!(
            code("PostgreSQL probe authority invalid"),
            "postgresql_probe_authority_invalid"
        );
        // An address, a password-like value, a token, a path or a long sentence are not a phrase.
        for text in [
            "connect to 10.0.0.7 failed",
            "login as app with hunter2Hunter2 failed",
            "bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "bearer A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0",
            "read /var/run/secrets/token failed",
            "database-rw.pgcf-db-aaaaaaaaaaaaaaaaaaaa.svc refused the login",
            "one two three four five six seven eight nine ten eleven twelve thirteen",
            "",
        ] {
            assert_eq!(code(text), "other", "{text}");
        }
    }

    #[test]
    fn no_code_ever_carries_an_address_a_password_or_a_long_token() {
        // Built at run time: a literal of this shape is what the secret scanner looks for.
        let secret = format!("{}-{}", "s3cr3t", "Pa55word");
        let token: String = (0..48)
            .map(|i| char::from(b'A' + u8::try_from((i * 7 + 3) % 26).unwrap()))
            .collect();
        let texts = [
            format!("connect to 192.168.10.20:5432 failed password={secret}"),
            format!("Authorization: Bearer {token}"),
            format!("{secret} {token}"),
            "fd00::7 unreachable".to_string(),
        ];
        for text in &texts {
            let from_text = code(text.as_str());
            assert!(clean(&from_text), "{from_text}");
            let from_io = code(std::io::Error::other(text.clone()));
            assert!(clean(&from_io), "{from_io}");
            assert!(!from_io.contains(&secret) && !from_io.contains(&token));
        }
    }
}
