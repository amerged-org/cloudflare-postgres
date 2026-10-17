// SPDX-License-Identifier: Apache-2.0
//! The password a client pipelines behind its StartupMessage, proven to PostgreSQL inside the
//! cluster. The gateway answers AuthenticationCleartextPassword, takes the password over the
//! encrypted WebSocket and runs SCRAM-SHA-256 to PostgreSQL itself, so a new connection costs the
//! client one round trip instead of three. HTTP SQL logs in with the same client. The password is
//! held only for that exchange: it is never logged or persisted, and it is zeroized when dropped.
//!
//! The gateway's one SCRAM client accepts a PostgreSQL that proves the password's verifier, or one
//! that asks for no password; any other request (a cleartext or MD5 password) never receives it.
//! Its PBKDF2 runs off the async workers, a bounded number at once, for at most
//! [`MAXIMUM_ITERATIONS`].
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_protocol::{constant, startup::error_response};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Semaphore,
};
use zeroize::{Zeroize, Zeroizing};

type Failure = Box<dyn std::error::Error + Send + Sync>;

/// AuthenticationCleartextPassword.
pub const CLEARTEXT_REQUEST: [u8; 9] = [b'R', 0, 0, 0, 8, 0, 0, 0, 3];
/// The longest message PostgreSQL may send while the gateway logs in for the client.
const MAXIMUM_MESSAGE: usize = 64 * 1024;
/// The most PBKDF2 iterations a PostgreSQL verifier may ask for: 25 times PostgreSQL's default
/// (4096), so no role's verifier makes a login cost the gateway more than milliseconds of CPU.
pub const MAXIMUM_ITERATIONS: u32 = 100_000;
/// The PBKDF2 derivations that run at once, on blocking threads.
static DERIVATIONS: Semaphore = Semaphore::const_new(2);

/// What a client pipelined behind its StartupMessage, in the message of the StartupMessage.
#[derive(Debug)]
pub enum Pipelined {
    /// No PasswordMessage leads it: the client logs in itself, with SCRAM end to end.
    Absent,
    /// A PasswordMessage begins, and the rest of it is still to come.
    Incomplete,
    /// A SASLInitialResponse of a client that guessed the mechanism: SCRAM end to end.
    Sasl,
    /// A password: the gateway logs in for the client.
    Password(Password),
    /// A password the gateway refuses: empty, or longer than the decoys accept.
    Refused,
}
enum Shape {
    Absent,
    Incomplete,
    Sasl,
    Password(usize),
    Refused,
}
/// A PasswordMessage holds one string with its terminator; a SASLInitialResponse always holds a
/// NUL after its mechanism and four bytes behind it.
fn shape(rest: &[u8]) -> Shape {
    if rest.first() != Some(&b'p') {
        return Shape::Absent;
    }
    if rest.len() < 5 {
        return Shape::Incomplete;
    }
    let length = u32::from_be_bytes(rest[1..5].try_into().unwrap()) as usize;
    if !(4..=constant("DECOY_AUTH_MAX_BYTES") as usize).contains(&length) {
        return Shape::Refused;
    }
    if rest.len() <= length {
        return Shape::Incomplete;
    }
    match rest[5..=length].split_last() {
        Some((0, [])) => Shape::Refused,
        Some((0, password)) if !password.contains(&0) => Shape::Password(length),
        _ => Shape::Sasl,
    }
}
/// Whether the client is asked for its password: none while the message is incomplete.
pub fn asks_password(rest: &[u8]) -> Option<bool> {
    match shape(rest) {
        Shape::Incomplete => None,
        Shape::Password(_) | Shape::Refused => Some(true),
        Shape::Absent | Shape::Sasl => Some(false),
    }
}

/// The answer to every password the gateway or PostgreSQL does not accept, byte for byte the
/// decoys' answer: an unknown route and a wrong password cannot be told apart.
pub fn refusal() -> Vec<u8> {
    error_response("28P01", "password authentication failed")
}

/// A client's password, zeroized when dropped.
pub struct Password(Zeroizing<Vec<u8>>);
impl Password {
    /// A password PostgreSQL could accept: none is empty, and none holds a NUL.
    pub fn new(bytes: Zeroizing<Vec<u8>>) -> Option<Self> {
        (!bytes.is_empty() && !bytes.contains(&0)).then_some(Self(bytes))
    }
}
impl std::fmt::Debug for Password {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Password(..)")
    }
}

/// Takes a pipelined password from the front of `rest`, zeroizing its bytes there. A refused one
/// zeroizes all of `rest`.
pub fn take_password(rest: &mut Vec<u8>) -> Pipelined {
    match shape(rest) {
        Shape::Absent => Pipelined::Absent,
        Shape::Sasl => Pipelined::Sasl,
        Shape::Incomplete => {
            if let Some(length) = rest
                .get(1..5)
                .map(|v| u32::from_be_bytes(v.try_into().unwrap()) as usize)
            {
                rest.reserve_exact((length + 1).saturating_sub(rest.len()));
            }
            Pipelined::Incomplete
        }
        Shape::Refused => {
            rest.zeroize();
            Pipelined::Refused
        }
        Shape::Password(length) => {
            let password = Password(Zeroizing::new(rest[5..length].to_vec()));
            rest[..=length].zeroize();
            rest.drain(..=length);
            Pipelined::Password(password)
        }
    }
}

/// SCRAM's SaltedPassword of a password for one salt and iteration count, zeroized when dropped.
pub struct Salted {
    salt: Vec<u8>,
    iterations: u32,
    key: Zeroizing<[u8; 32]>,
}
impl Salted {
    /// Derives it on a blocking thread, at most [`DERIVATIONS`] at once.
    pub async fn derive(
        password: &Password,
        salt: Vec<u8>,
        iterations: u32,
    ) -> Result<Self, Failure> {
        if salt.is_empty() || !(1..=MAXIMUM_ITERATIONS).contains(&iterations) {
            return Err("invalid SCRAM salt or iteration count".into());
        }
        // The permit moves with the work, so a cancelled login still bounds what runs.
        let permit = DERIVATIONS.acquire().await?;
        let password = password.0.clone();
        let (salt, key) = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let key = salted_password(&password, &salt, iterations);
            (salt, key)
        })
        .await?;
        Ok(Self {
            salt,
            iterations,
            key,
        })
    }
    /// What PostgreSQL stores for the password: enough to recognise it, not to recover it.
    pub fn verifier(&self) -> Verifier {
        let client_key = Zeroizing::new(hmac(&*self.key, b"Client Key"));
        Verifier {
            salt: self.salt.clone(),
            iterations: self.iterations,
            stored_key: Sha256::digest(client_key.as_slice()).into(),
        }
    }
}
/// A password's SCRAM verifier: its salt, iteration count and StoredKey.
#[derive(Clone, PartialEq, Eq)]
pub struct Verifier {
    pub salt: Vec<u8>,
    pub iterations: u32,
    stored_key: [u8; 32],
}
impl Verifier {
    /// Whether both were derived from the same password, compared in constant time.
    pub fn same(&self, other: &Verifier) -> bool {
        self.salt == other.salt
            && self.iterations == other.iterations
            && self
                .stored_key
                .iter()
                .zip(other.stored_key)
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                == 0
    }
}

/// How PostgreSQL answered the gateway's login.
#[derive(Debug, PartialEq, Eq)]
pub enum Login {
    /// AuthenticationOk and what PostgreSQL sent behind it through ReadyForQuery (or an
    /// ErrorResponse), for the client as it is, with the verifier PostgreSQL proved (none when it
    /// asked for no password).
    Authenticated(Vec<u8>, Option<Verifier>),
    /// PostgreSQL did not accept the password (28P01).
    Refused,
    /// Another ErrorResponse of PostgreSQL, for the client as it is.
    Failed(Vec<u8>),
}

impl std::fmt::Debug for Verifier {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Verifier(..)")
    }
}

/// Logs in to PostgreSQL, whose StartupMessage was written, with the client's password. Only a
/// PostgreSQL that proves it holds the password's verifier is trusted with the session. `known`,
/// derived for the same password, is used when PostgreSQL asks for its salt and iterations.
pub async fn login<S: AsyncRead + AsyncWrite + Unpin>(
    postgres: &mut S,
    password: &Password,
    known: Option<Salted>,
) -> Result<Login, Failure> {
    let mut random = [0u8; 18];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut random)
        .map_err(|_| "random source unavailable")?;
    login_with(postgres, password, &STANDARD.encode(random), known).await
}

async fn login_with<S: AsyncRead + AsyncWrite + Unpin>(
    postgres: &mut S,
    password: &Password,
    nonce: &str,
    mut known: Option<Salted>,
) -> Result<Login, Failure> {
    let mut backend = Backend::default();
    let mut scram: Option<Scram> = None;
    loop {
        let (tag, body) = backend.message(postgres).await?;
        if tag == b'E' {
            return Ok(if sqlstate(&body) == Some(b"28P01".as_slice()) {
                Login::Refused
            } else {
                Login::Failed(frame(tag, &body))
            });
        }
        if tag != b'R' || body.len() < 4 {
            return Err("unexpected message before authentication".into());
        }
        let code = u32::from_be_bytes(body[..4].try_into().unwrap());
        let data = &body[4..];
        match (code, &mut scram) {
            // Without SASL only when PostgreSQL asks for no password at all.
            (0, None) | (0, Some(Scram { verified: true, .. })) if data.is_empty() => {
                let verifier = scram.and_then(|scram| scram.verifier);
                return Ok(Login::Authenticated(
                    backend.through_ready(postgres, frame(tag, &body)).await?,
                    verifier,
                ));
            }
            (10, None) => {
                if !data
                    .split(|v| *v == 0)
                    .any(|mechanism| mechanism == b"SCRAM-SHA-256")
                {
                    return Err("PostgreSQL offers no SCRAM-SHA-256".into());
                }
                let started = Scram::new(nonce);
                postgres.write_all(&started.initial_response()).await?;
                postgres.flush().await?;
                scram = Some(started);
            }
            (11, Some(started)) if started.server_signature.is_none() => {
                let (salt, iterations) = started.server_first(data)?;
                let salted = match known.take() {
                    Some(known) if known.salt == salt && known.iterations == iterations => known,
                    _ => Salted::derive(password, salt, iterations).await?,
                };
                let response = started.client_final(&salted, data);
                postgres.write_all(&response).await?;
                postgres.flush().await?;
            }
            (12, Some(started)) if !started.verified => started.verify(data)?,
            _ => return Err("unexpected authentication request".into()),
        }
    }
}

/// The client side of one SCRAM-SHA-256 exchange without channel binding (RFC 5802, RFC 7677).
struct Scram {
    client_first_bare: String,
    nonce: String,
    server_signature: Option<[u8; 32]>,
    verifier: Option<Verifier>,
    verified: bool,
}
impl Scram {
    fn new(nonce: &str) -> Self {
        // PostgreSQL takes the user from the StartupMessage and ignores this one.
        Self::for_user("", nonce)
    }
    fn for_user(user: &str, nonce: &str) -> Self {
        Self {
            client_first_bare: format!("n={user},r={nonce}"),
            nonce: nonce.into(),
            server_signature: None,
            verifier: None,
            verified: false,
        }
    }
    fn initial_response(&self) -> Vec<u8> {
        let first = format!("n,,{}", self.client_first_bare);
        let mut body = b"SCRAM-SHA-256\0".to_vec();
        body.extend_from_slice(&(first.len() as u32).to_be_bytes());
        body.extend_from_slice(first.as_bytes());
        frame(b'p', &body)
    }
    /// The salt and iteration count of a server-first message that extends the client's nonce.
    fn server_first(&self, server_first: &[u8]) -> Result<(Vec<u8>, u32), Failure> {
        let server_first =
            std::str::from_utf8(server_first).map_err(|_| "invalid SCRAM server-first message")?;
        let mut parts = server_first.split(',');
        let (Some(combined), Some(salt), Some(iterations), None) = (
            parts.next().and_then(|v| v.strip_prefix("r=")),
            parts.next().and_then(|v| v.strip_prefix("s=")),
            parts.next().and_then(|v| v.strip_prefix("i=")),
            parts.next(),
        ) else {
            return Err("invalid SCRAM server-first message".into());
        };
        let salt = STANDARD
            .decode(salt)
            .map_err(|_| "invalid SCRAM salt")
            .and_then(|salt| (!salt.is_empty()).then_some(salt).ok_or("empty SCRAM salt"))?;
        let iterations = iterations
            .parse::<u32>()
            .ok()
            .filter(|v| (1..=MAXIMUM_ITERATIONS).contains(v))
            .ok_or("invalid SCRAM iteration count")?;
        if combined.len() <= self.nonce.len()
            || !combined.starts_with(&self.nonce)
            || !combined
                .bytes()
                .all(|v| (0x21..=0x7e).contains(&v) && v != b',')
        {
            return Err("invalid SCRAM server nonce".into());
        }
        Ok((salt, iterations))
    }
    /// The client-final message for a checked server-first message, as a SASLResponse.
    fn client_final(&mut self, salted: &Salted, server_first: &[u8]) -> Vec<u8> {
        let server_first = String::from_utf8_lossy(server_first);
        let combined = &server_first[2..server_first.find(',').expect("checked server-first")];
        let client_key = Zeroizing::new(hmac(&*salted.key, b"Client Key"));
        let stored_key = Sha256::digest(client_key.as_slice());
        let without_proof = format!("c=biws,r={combined}");
        let message = format!("{},{server_first},{without_proof}", self.client_first_bare);
        let signature = hmac(&stored_key, message.as_bytes());
        let mut proof = Zeroizing::new([0u8; 32]);
        for (index, byte) in proof.iter_mut().enumerate() {
            *byte = client_key[index] ^ signature[index];
        }
        self.server_signature = Some(hmac(&hmac(&*salted.key, b"Server Key"), message.as_bytes()));
        self.verifier = Some(salted.verifier());
        let client_final = format!("{without_proof},p={}", STANDARD.encode(*proof));
        frame(b'p', client_final.as_bytes())
    }
    /// Checks the server-final message against the verifier the password derives.
    fn verify(&mut self, server_final: &[u8]) -> Result<(), Failure> {
        let expected = self.server_signature.ok_or("SCRAM exchange incomplete")?;
        let received = server_final
            .strip_prefix(b"v=")
            .and_then(|v| STANDARD.decode(v).ok())
            .filter(|v| v.len() == expected.len())
            .ok_or("invalid SCRAM server-final message")?;
        if received
            .iter()
            .zip(expected)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            != 0
        {
            return Err("PostgreSQL did not prove the password's verifier".into());
        }
        self.verified = true;
        Ok(())
    }
}
fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}
/// PBKDF2-HMAC-SHA-256 with one 32-byte block: SCRAM's SaltedPassword.
fn salted_password(password: &[u8], salt: &[u8], iterations: u32) -> Zeroizing<[u8; 32]> {
    let key = Hmac::<Sha256>::new_from_slice(password).expect("HMAC takes any key length");
    let mut first = key.clone();
    first.update(salt);
    first.update(&1u32.to_be_bytes());
    let mut block = Zeroizing::new(<[u8; 32]>::from(first.finalize().into_bytes()));
    let mut result = Zeroizing::new(*block);
    for _ in 1..iterations {
        let mut next = key.clone();
        next.update(&*block);
        *block = next.finalize().into_bytes().into();
        for (a, b) in result.iter_mut().zip(block.iter()) {
            *a ^= b;
        }
    }
    result
}
fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(body.len() + 5);
    bytes.push(tag);
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
/// The SQLSTATE field of an ErrorResponse body.
fn sqlstate(body: &[u8]) -> Option<&[u8]> {
    let mut fields = body;
    while let Some((&kind, rest)) = fields.split_first() {
        if kind == 0 {
            return None;
        }
        let end = rest.iter().position(|v| *v == 0)?;
        if kind == b'C' {
            return Some(&rest[..end]);
        }
        fields = &rest[end + 1..];
    }
    None
}
/// PostgreSQL's messages during the login, read whole.
#[derive(Default)]
struct Backend {
    buffer: Vec<u8>,
}
impl Backend {
    async fn message<S: AsyncRead + Unpin>(
        &mut self,
        postgres: &mut S,
    ) -> Result<(u8, Vec<u8>), Failure> {
        loop {
            if self.buffer.len() >= 5 {
                let length = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap()) as usize;
                if !(4..=MAXIMUM_MESSAGE).contains(&length) {
                    return Err("invalid message from PostgreSQL".into());
                }
                if self.buffer.len() > length {
                    let body = self.buffer[5..length + 1].to_vec();
                    let tag = self.buffer[0];
                    self.buffer.drain(..length + 1);
                    return Ok((tag, body));
                }
            }
            let mut chunk = [0u8; 4096];
            let read = postgres.read(&mut chunk).await?;
            if read == 0 {
                return Err("PostgreSQL ended the login".into());
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }
    /// AuthenticationOk (`ok`) and what follows it through ReadyForQuery or an ErrorResponse,
    /// with any bytes PostgreSQL sent behind them.
    async fn through_ready<S: AsyncRead + Unpin>(
        mut self,
        postgres: &mut S,
        mut ok: Vec<u8>,
    ) -> Result<Vec<u8>, Failure> {
        loop {
            let (tag, body) = self.message(postgres).await?;
            ok.extend(frame(tag, &body));
            if matches!(tag, b'Z' | b'E') || ok.len() >= MAXIMUM_MESSAGE {
                ok.append(&mut self.buffer);
                return Ok(ok);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    const SERVER_FIRST: &[u8] =
        b"r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
    fn password(value: &[u8]) -> Password {
        Password::new(Zeroizing::new(value.to_vec())).unwrap()
    }
    async fn continue_with(scram: &mut Scram, value: &[u8], server_first: &[u8]) -> Vec<u8> {
        let (salt, iterations) = scram.server_first(server_first).unwrap();
        let salted = Salted::derive(&password(value), salt, iterations)
            .await
            .unwrap();
        scram.client_final(&salted, server_first)
    }

    #[tokio::test]
    async fn the_scram_exchange_matches_the_rfc_7677_test_vector() {
        let mut scram = Scram::for_user("user", "rOprNGfwEbeRWgbNEkqO");
        let initial = scram.initial_response();
        assert_eq!(&initial[5..19], b"SCRAM-SHA-256\0");
        assert_eq!(&initial[23..], b"n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
        let response = continue_with(&mut scram, b"pencil", SERVER_FIRST).await;
        assert_eq!(
            &response[5..],
            b"c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
        );
        assert!(
            scram
                .verify(b"v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
                .is_ok()
        );
        let mut forged = Scram::for_user("user", "rOprNGfwEbeRWgbNEkqO");
        continue_with(&mut forged, b"pencil", SERVER_FIRST).await;
        assert!(
            forged
                .verify(b"v=7rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
                .is_err()
        );
        assert!(!forged.verified);
    }

    #[test]
    fn a_server_first_message_that_does_not_extend_the_nonce_or_bounds_the_work_is_refused() {
        for server_first in [
            "r=client,s=c2FsdA==,i=4096",
            "r=otherserver,s=c2FsdA==,i=4096",
            "r=clientserver,s=,i=4096",
            "r=clientserver,s=c2FsdA==,i=0",
            "r=clientserver,s=c2FsdA==,i=100001",
            "r=clientserver,s=c2FsdA==,i=4096,m=extension",
            "r=client server,s=c2FsdA==,i=4096",
        ] {
            assert!(
                Scram::new("client")
                    .server_first(server_first.as_bytes())
                    .is_err(),
                "{server_first}"
            );
        }
    }

    #[test]
    fn pbkdf2_runs_off_the_async_workers() {
        // One worker thread: a derivation on it would stop the ticker until it ends.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let ticks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = ticks.clone();
            let ticker = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            });
            let started = std::time::Instant::now();
            Salted::derive(&password(b"pencil"), b"salt".to_vec(), MAXIMUM_ITERATIONS)
                .await
                .unwrap();
            let elapsed = started.elapsed();
            ticker.abort();
            let ticks = ticks.load(std::sync::atomic::Ordering::SeqCst);
            assert!(
                elapsed.as_millis() < 10 || ticks as u128 >= elapsed.as_millis() / 4,
                "{ticks} ticks in {elapsed:?}"
            );
        });
    }

    #[tokio::test]
    async fn a_known_salted_password_for_the_same_salt_and_iterations_is_not_derived_again() {
        let salt = STANDARD.decode("W22ZaJ0SNY7soEsUEjb6gQ==").unwrap();
        // Derived from the RFC's password: the proof shows it was used for this one.
        let known = Salted::derive(&password(b"pencil"), salt.clone(), 4096)
            .await
            .unwrap();
        let mut scram = Scram::for_user("user", "rOprNGfwEbeRWgbNEkqO");
        let (salt_asked, iterations) = scram.server_first(SERVER_FIRST).unwrap();
        assert_eq!((salt_asked, iterations), (salt, 4096));
        assert!(known.verifier().same(&known.verifier()));
        let response = scram.client_final(&known, SERVER_FIRST);
        assert!(response.ends_with(b"p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="));
        let other = Salted::derive(&password(b"pencil2"), known.salt.clone(), 4096)
            .await
            .unwrap();
        assert!(!known.verifier().same(&other.verifier()));
        assert!(
            Salted::derive(&password(b"pencil"), Vec::new(), 4096)
                .await
                .is_err()
        );
    }

    #[test]
    fn a_pipelined_password_is_taken_whole_and_zeroized_where_it_was() {
        let mut rest = b"p\0\0\0\x0bsecret\0Q\0\0\0\x06x\0".to_vec();
        assert_eq!(asks_password(&rest), Some(true));
        let Pipelined::Password(password) = take_password(&mut rest) else {
            panic!("password not taken");
        };
        assert_eq!(password.0.as_slice(), b"secret");
        assert_eq!(rest, b"Q\0\0\0\x06x\0");
        assert_eq!(format!("{password:?}"), "Password(..)");
        let mut partial = b"p\0\0\0\x0bsec".to_vec();
        assert_eq!(asks_password(&partial), None);
        assert!(matches!(take_password(&mut partial), Pipelined::Incomplete));
        assert_eq!(partial, b"p\0\0\0\x0bsec");
        for refused in [
            b"p\0\0\0\x05\0".to_vec(),
            b"p\0\0\0\x03".to_vec(),
            [b"p\0\0\x10\x01".as_slice(), b"x"].concat(),
        ] {
            let mut rest = refused.clone();
            assert_eq!(asks_password(&rest), Some(true));
            assert!(
                matches!(take_password(&mut rest), Pipelined::Refused),
                "{refused:?}"
            );
            assert!(rest.is_empty());
        }
    }

    #[test]
    fn a_pipelined_sasl_message_or_none_keeps_scram_end_to_end() {
        let mut first = b"SCRAM-SHA-256\0".to_vec();
        first.extend_from_slice(&15u32.to_be_bytes());
        first.extend_from_slice(b"n,,n=,r=client\0");
        for kept in [
            frame(b'p', &first),
            b"p\0\0\0\x08a\0b\0".to_vec(),
            b"p\0\0\0\x08abcd".to_vec(),
            b"Q\0\0\0\x06x\0".to_vec(),
            Vec::new(),
        ] {
            let mut rest = kept.clone();
            assert_eq!(asks_password(&rest), Some(false), "{kept:?}");
            assert!(matches!(
                take_password(&mut rest),
                Pipelined::Sasl | Pipelined::Absent
            ));
            assert_eq!(rest, kept);
        }
    }

    #[test]
    fn the_refusal_is_the_decoys() {
        assert_eq!(
            refusal(),
            b"E\0\0\0\x3aSFATAL\0VFATAL\0C28P01\0Mpassword authentication failed\0\0"
        );
    }

    /// A PostgreSQL whose answers are fixed, recording what the gateway wrote to it.
    async fn exchange(answers: Vec<Vec<u8>>) -> (Result<Login, Failure>, Vec<u8>) {
        let (mut gateway, mut postgres) = duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let mut written = Vec::new();
            for answer in answers {
                postgres.write_all(&answer).await.unwrap();
                let mut chunk = [0u8; 4096];
                match tokio::time::timeout(
                    std::time::Duration::from_millis(100),
                    postgres.read(&mut chunk),
                )
                .await
                {
                    Ok(Ok(read)) => written.extend_from_slice(&chunk[..read]),
                    _ => break,
                }
            }
            written
        });
        let login = login_with(
            &mut gateway,
            &password(b"pencil"),
            "rOprNGfwEbeRWgbNEkqO",
            None,
        )
        .await;
        drop(gateway);
        (login, server.await.unwrap())
    }

    #[tokio::test]
    async fn authentication_ok_is_trusted_only_after_the_server_signature() {
        let ready = [
            frame(b'R', &[0, 0, 0, 0]),
            frame(b'S', b"a\0b\0"),
            frame(b'Z', b"I"),
        ]
        .concat();
        // AuthenticationOk before the server-final message is never trusted.
        let (login, _) = exchange(vec![
            frame(b'R', b"\0\0\0\x0aSCRAM-SHA-256\0\0"),
            frame(b'R', &[0, 0, 0, 0]),
        ])
        .await;
        assert!(login.is_err());
        // A PostgreSQL that asks for no password logs in as it is.
        let (login, written) = exchange(vec![ready.clone()]).await;
        assert_eq!(login.unwrap(), Login::Authenticated(ready.clone(), None));
        assert!(written.is_empty());
        // A cleartext (or MD5) request never receives the password.
        let (login, written) = exchange(vec![frame(b'R', &[0, 0, 0, 3])]).await;
        assert!(login.is_err());
        assert!(written.is_empty());
        let (login, written) = exchange(vec![frame(b'R', &[0, 0, 0, 5, 1, 2, 3, 4])]).await;
        assert!(login.is_err());
        assert!(written.is_empty());
        // The whole exchange: the verifier PostgreSQL proved comes back with the session.
        let salt = STANDARD.decode("W22ZaJ0SNY7soEsUEjb6gQ==").unwrap();
        let server_first = std::str::from_utf8(SERVER_FIRST).unwrap();
        let combined = &server_first[2..server_first.find(',').unwrap()];
        let message = format!("n=,r=rOprNGfwEbeRWgbNEkqO,{server_first},c=biws,r={combined}");
        let server_key = hmac(&*salted_password(b"pencil", &salt, 4096), b"Server Key");
        let signature = STANDARD.encode(hmac(&server_key, message.as_bytes()));
        let server_final = [&[0, 0, 0, 12], format!("v={signature}").as_bytes()].concat();
        let (login, _) = exchange(vec![
            frame(b'R', b"\0\0\0\x0aSCRAM-SHA-256\0\0"),
            frame(b'R', &[&[0, 0, 0, 11], SERVER_FIRST].concat()),
            [frame(b'R', &server_final), ready.clone()].concat(),
        ])
        .await;
        let Login::Authenticated(answer, Some(verifier)) = login.unwrap() else {
            panic!("not authenticated with a verifier");
        };
        assert_eq!(answer, ready);
        let expected = Salted::derive(&password(b"pencil"), salt, 4096)
            .await
            .unwrap();
        assert!(verifier.same(&expected.verifier()));
        // Its refusal of the password is the decoys' class; any other error goes through.
        let refused = frame(
            b'E',
            b"SFATAL\0C28P01\0Mpassword authentication failed for user\0\0",
        );
        let (login, _) = exchange(vec![refused]).await;
        assert_eq!(login.unwrap(), Login::Refused);
        let full = frame(b'E', b"SFATAL\0C53300\0Mtoo many connections\0\0");
        let (login, _) = exchange(vec![full.clone()]).await;
        assert_eq!(login.unwrap(), Login::Failed(full));
        // No SCRAM-SHA-256 offered: nothing is sent.
        let (login, written) = exchange(vec![frame(b'R', b"\0\0\0\x0aOTHER\0\0")]).await;
        assert!(login.is_err());
        assert!(written.is_empty());
    }
}
