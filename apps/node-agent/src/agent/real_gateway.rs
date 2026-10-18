// SPDX-License-Identifier: Apache-2.0
//! The agent core against the real gateway on its channel (plan 5.7, 5.9, 7.9): the two crates
//! that speak `pgcf_native_protocol::agent` talk to each other, over a real Unix socket, with a
//! real PostgreSQL behind. A client's session is reached through a route made for the node, ends
//! with the close the sleep proof asks for, and a wake ticket is held, released by the agent's
//! table, or refused with the contract's detail and hint.
use super::{
    power::{Slept, Why},
    testing::{Rig, eventually},
};
use crate::testpg;
use futures_util::{SinkExt, StreamExt};
use pgcf_native_gateway::{
    local,
    transport::{self, Config, Gateway},
};
use pgcf_native_protocol::{
    route::{self, Connection, Keyring, NodeTarget},
    wake::{self, Ticket, WakeRequest},
};
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Semaphore, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const NODE: &str = "nod_nnnnnnnnnnnnnnnnnnnn";
const REGION: &str = "eu-dev";
/// The master key of the Edge; the gateway holds the key derived for its node.
const MASTER: [u8; 32] = [7; 32];

fn master() -> Keyring {
    Keyring {
        active: "test".into(),
        keys: HashMap::from([("test".into(), MASTER.to_vec())]),
    }
}
fn connection<'a>(database: &'a str, cid: &'a str) -> Connection<'a> {
    Connection {
        region: REGION,
        node: NODE,
        database,
        user: "app",
        cid,
        now_ms: u64::try_from(crate::agent::now_ms()).unwrap(),
        ttl_seconds: 30,
    }
}
fn cid(number: usize) -> String {
    format!("01234567-89ab-4def-8123-{number:012x}")
}

/// The gateway of the node, listening on loopback, on the agent's channel.
struct Front {
    port: u16,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
impl Front {
    async fn start(rig: &Rig) -> Self {
        let derived = route::derive_node_key(&MASTER, NODE).unwrap();
        let gateway = Gateway::new(Arc::new(Config {
            region: REGION.into(),
            node: NODE.into(),
            keyring: Keyring {
                active: "test".into(),
                keys: HashMap::from([("test".into(), derived)]),
            },
            maximum_memory: 192 << 20,
            database_memory: 96 << 20,
        }));
        let (stop, receiver) = watch::channel(false);
        let channel = tokio::spawn(local::synchronize(
            gateway.clone(),
            rig.root.join("g.sock"),
            receiver.clone(),
        ));
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = tcp.local_addr().unwrap().port();
        let serving = gateway.clone();
        let server = tokio::spawn(async move {
            let pending = Arc::new(Semaphore::new(128));
            loop {
                let Ok((socket, _)) = tcp.accept().await else {
                    return;
                };
                let (gateway, receiver) = (serving.clone(), receiver.clone());
                let permit = pending.clone().acquire_owned().await.unwrap();
                tokio::spawn(async move {
                    let _ = transport::serve_socket(socket, gateway, receiver, permit).await;
                });
            }
        });
        eventually(10, "the gateway to hold the agent's table", || {
            gateway
                .table
                .try_read()
                .is_ok_and(|table| table.synchronized())
        })
        .await;
        Self {
            port,
            stop,
            tasks: vec![channel, server],
        }
    }
    async fn upgrade(&self, route: &str) -> Client {
        let mut request = format!("ws://127.0.0.1:{}/pg", self.port)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("x-pgcf-route", route.parse().unwrap());
        let (socket, _) = timeout(Duration::from_secs(10), connect_async(request))
            .await
            .expect("the gateway upgrades")
            .expect("the gateway upgrades");
        Client {
            socket,
            buffer: Vec::new(),
        }
    }
}
impl Drop for Front {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// A PostgreSQL client over the gateway's WebSocket.
struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    buffer: Vec<u8>,
}
fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
/// What the client ends with: the gateway's close frame, or the FATAL error it sent first.
#[derive(Debug, PartialEq, Eq)]
enum End {
    Closed(Option<(u16, String)>),
    Refused {
        sqlstate: String,
        detail: Option<String>,
        hint: Option<String>,
    },
}
fn field(body: &[u8], tag: u8) -> Option<String> {
    body.split(|byte| *byte == 0)
        .find_map(|part| part.strip_prefix(&[tag]))
        .map(|value| String::from_utf8_lossy(value).into_owned())
}
impl Client {
    async fn send(&mut self, bytes: Vec<u8>) {
        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .unwrap();
    }
    /// The next PostgreSQL message, or how the connection ended.
    async fn message(&mut self) -> Result<(u8, Vec<u8>), End> {
        loop {
            if self.buffer.len() >= 5 {
                let length = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap()) as usize;
                if self.buffer.len() > length {
                    let message: Vec<u8> = self.buffer.drain(..=length).collect();
                    let (tag, body) = (message[0], message[5..].to_vec());
                    if tag == b'E' {
                        return Err(End::Refused {
                            sqlstate: field(&body, b'C').unwrap_or_default(),
                            detail: field(&body, b'D'),
                            hint: field(&body, b'H'),
                        });
                    }
                    return Ok((tag, body));
                }
            }
            match timeout(Duration::from_secs(30), self.socket.next())
                .await
                .expect("the gateway answers")
            {
                Some(Ok(Message::Binary(bytes))) => self.buffer.extend_from_slice(&bytes),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    return Err(End::Closed(
                        frame.map(|frame| (u16::from(frame.code), frame.reason.to_string())),
                    ));
                }
                _ => return Err(End::Closed(None)),
            }
        }
    }
    /// The StartupMessage with the password pipelined behind it, as the Edge's clients send it.
    async fn login(&mut self, database: &str) -> Result<(), End> {
        let body = format!("user\0app\0database\0{database}\0\0");
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&196_608u32.to_be_bytes());
        bytes.extend_from_slice(body.as_bytes());
        bytes.extend_from_slice(&frame(
            b'p',
            format!("{}\0", testpg::password(1)).as_bytes(),
        ));
        self.send(bytes).await;
        loop {
            if self.message().await?.0 == b'Z' {
                return Ok(());
            }
        }
    }
    /// The first column of the first row of a simple query.
    async fn value(&mut self, sql: &str) -> Result<String, End> {
        self.send(frame(b'Q', format!("{sql}\0").as_bytes())).await;
        let mut value = None;
        loop {
            let (tag, body) = self.message().await?;
            if tag == b'D' {
                let length = i32::from_be_bytes(body[2..6].try_into().unwrap()) as usize;
                value = Some(String::from_utf8(body[6..6 + length].to_vec()).unwrap());
            }
            if tag == b'Z' {
                return Ok(value.expect("a row"));
            }
        }
    }
}

/// The ticket the Edge signs for `request`.
fn ticket_token(request: &WakeRequest, number: usize) -> String {
    let cid = cid(number);
    wake::sign_wake(
        &master(),
        &connection(&request.database, &cid),
        &Ticket {
            operation: &request.operation,
            generation: request.generation,
            route_revision: request.route_revision,
            role_revision_hash: &request.role_revision_hash,
        },
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_ends_with_the_sleeps_close_and_a_wake_is_released_or_refused_as_the_contract_says()
 {
    let Some(mut rig) = Rig::new("real-gateway").await else {
        return;
    };
    let mut page = rig.entry_json();
    let (entry, db) = rig.create_from(&page).await;
    let wakes = rig.serve_wakes();
    let front = Front::start(&rig).await;

    // A route made for this node reaches the unit the agent started.
    let table = rig.gateway.get(&entry.id).unwrap();
    let unit = table.writer.clone().unwrap();
    let id = cid(1);
    let awake = route::sign(
        &master(),
        &connection(&entry.id, &id),
        &NodeTarget {
            revision: table.generation,
            route_revision: table.route_revision,
            instance: &unit.instance,
        },
    )
    .unwrap();
    let mut client = front.upgrade(&awake).await;
    client.login(&entry.id).await.unwrap();
    assert_eq!(client.value("select 1").await.unwrap(), "1");

    // The sleep proof quiesces the gateway and has it close the idle session before the unit
    // stops: the close the plan names (7.9, step 1), not a broken stream.
    assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
    assert_eq!(
        client.message().await.unwrap_err(),
        End::Closed(Some((1000, "database sleeping".into())))
    );

    // A ticket for the next generation is held by the gateway, the agent starts the unit, and its
    // table entry releases the session.
    let first = Rig::ticket(&entry);
    let mut client = front.upgrade(&ticket_token(&first, 2)).await;
    client.login(&entry.id).await.unwrap();
    assert_eq!(client.value("select 'woken'").await.unwrap(), "woken");
    assert_eq!(
        rig.gateway.get(&entry.id).unwrap().generation,
        first.generation
    );

    // Cloudflare's claim of that wake is the page's next generation.
    page.as_object_mut().unwrap().remove("origin");
    page["generation"] = first.generation.into();
    page["operation"] = first.operation.clone().into();
    rig.core.apply(&Rig::page(vec![page.clone()], vec![])).await;

    // Asleep again, and Cloudflare records the hibernation at the next generation (an idle sleeper
    // is on the page as running, since a connect wakes it), and the Edge's next ticket claims the
    // one after.
    assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
    page["generation"] = (first.generation + 1).into();
    page["operation"] = format!("op_{}", "z".repeat(20)).into();
    let mut desired = Rig::page(vec![page], vec![]);
    // The admission queue holds a start past the gateway's redelivery of its ticket.
    desired.policy["admission"]["queue_wait_ms"] = json!(wake::REDELIVER_MS + 500);
    rig.core.apply(&desired).await;
    let next = |letter: char| WakeRequest {
        generation: first.generation + 2,
        operation: format!("op_{}", letter.to_string().repeat(20)),
        ..first.clone()
    };
    // A wake that finds no memory waits for the queue. The gateway delivers its ticket again
    // meanwhile, the agent answers that it is on it, and the client keeps waiting: it is told what
    // the contract names when the wait ends, 57P03 with the detail of awake capacity and the hint
    // of the retry.
    rig.machine.set_available_bytes(0);
    let mut client = front.upgrade(&ticket_token(&next('x'), 3)).await;
    let waited = std::time::Instant::now();
    assert_eq!(
        client.login(&entry.id).await.unwrap_err(),
        End::Refused {
            sqlstate: "57P03".into(),
            detail: Some("node at awake capacity".into()),
            hint: Some("retry after 5 s".into()),
        }
    );
    assert!(waited.elapsed() >= Duration::from_millis(wake::REDELIVER_MS + 500));
    // The same wake asked again finds the pool without room: it is refused at once, with the
    // detail of storage and no hint.
    rig.machine.set_available_bytes(8 << 30);
    rig.machine.set_no_room(true);
    let mut client = front.upgrade(&ticket_token(&next('x'), 4)).await;
    assert_eq!(
        client.login(&entry.id).await.unwrap_err(),
        End::Refused {
            sqlstate: "57P03".into(),
            detail: Some("storage".into()),
            hint: None,
        }
    );
    assert!(!rig.machine.running(&entry.id));
    wakes.abort();
}
