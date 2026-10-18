// SPDX-License-Identifier: Apache-2.0
//! SCRAM-SHA-256 verifiers (RFC 5802, RFC 7677; PostgreSQL's `rolpassword`). The agent hands
//! PostgreSQL the verifier of a role's password and never the password: it is not in the statement
//! text that a failing statement writes to the server's log.
use base64::{Engine, engine::general_purpose::STANDARD};
use ring::{
    digest, hmac, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use std::num::NonZeroU32;

/// PostgreSQL's default for `scram_iterations`.
const ITERATIONS: u32 = 4096;
const SALT_BYTES: usize = 16;

/// The verifier of `password` for the salt and iteration count given; `None` for an iteration
/// count of zero and for a password that SASLprep (RFC 4013) would change or refuse: only printable
/// ASCII passes through it unchanged.
pub fn verifier_with(password: &str, salt: &[u8], iterations: u32) -> Option<String> {
    let iterations = NonZeroU32::new(iterations)?;
    if password.is_empty() || !password.bytes().all(|b| (0x20..=0x7E).contains(&b)) {
        return None;
    }
    let mut salted = [0u8; digest::SHA256_OUTPUT_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        salt,
        password.as_bytes(),
        &mut salted,
    );
    let key = hmac::Key::new(hmac::HMAC_SHA256, &salted);
    let client_key = hmac::sign(&key, b"Client Key");
    let stored_key = digest::digest(&digest::SHA256, client_key.as_ref());
    let server_key = hmac::sign(&key, b"Server Key");
    Some(format!(
        "SCRAM-SHA-256${iterations}:{}${}:{}",
        STANDARD.encode(salt),
        STANDARD.encode(stored_key.as_ref()),
        STANDARD.encode(server_key.as_ref()),
    ))
}

/// The verifier of `password` with a salt of its own.
pub fn verifier(password: &str) -> Option<String> {
    let mut salt = [0u8; SALT_BYTES];
    SystemRandom::new().fill(&mut salt).ok()?;
    verifier_with(password, &salt, ITERATIONS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{postgres, testpg::Cluster};

    /// PostgreSQL's own verifier of a password, read back from the catalog.
    async fn catalog_verifier(agent: &postgres::Session, role: &str) -> String {
        let rows = agent
            .query(
                "SELECT rolpassword FROM pg_catalog.pg_authid WHERE rolname = $1",
                &[&role],
            )
            .await
            .unwrap();
        rows[0].get::<_, String>(0)
    }

    #[tokio::test]
    async fn the_verifier_is_the_one_postgresql_makes_and_logs_in() {
        let Some(cluster) = Cluster::create("scram") else {
            return;
        };
        cluster.start();
        let agent = cluster.agent().await;
        let password = &crate::testpg::password(1);
        agent
            .batch(&format!("CREATE ROLE own LOGIN PASSWORD '{password}'"))
            .await
            .unwrap();
        // The same salt and iterations give the same bytes.
        let theirs = catalog_verifier(&agent, "own").await;
        let (head, rest) = theirs.split_once('$').unwrap();
        let (iterations, rest) = rest.split_once(':').unwrap();
        let (salt, _) = rest.split_once('$').unwrap();
        assert_eq!(head, "SCRAM-SHA-256");
        let salt =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, salt).unwrap();
        let ours = verifier_with(password, &salt, iterations.parse().unwrap()).unwrap();
        assert_eq!(ours, theirs);

        // A role that holds ours logs in with the password, over the socket, by SCRAM.
        let made = verifier(password).unwrap();
        assert!(made.starts_with("SCRAM-SHA-256$4096:"));
        agent
            .batch(&format!("CREATE ROLE other LOGIN PASSWORD '{made}'"))
            .await
            .unwrap();
        let mut config = tokio_postgres::Config::new();
        config
            .host_path(cluster.socket_directory())
            .port(crate::layout::PORT)
            .user("other")
            .password(password)
            .dbname("postgres");
        let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(connection);
        let row = client
            .query_one("SELECT current_user::text", &[])
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "other");
        // Another password is refused.
        config.password("not-the-password");
        assert!(config.connect(tokio_postgres::NoTls).await.is_err());
    }

    #[test]
    fn two_verifiers_of_one_password_differ_by_their_salt_and_a_bad_password_has_none() {
        let a = verifier("abc").unwrap();
        let b = verifier("abc").unwrap();
        assert_ne!(a, b);
        assert!(verifier_with("abc", &[0; 16], 0).is_none());
        // SASLprep would change a password with a non-ASCII character; the contract's passwords
        // are ASCII, and the agent refuses what it does not prepare.
        assert!(verifier("päss").is_none());
        assert!(verifier("").is_none());
        assert!(verifier("a\0b").is_none());
    }
}
