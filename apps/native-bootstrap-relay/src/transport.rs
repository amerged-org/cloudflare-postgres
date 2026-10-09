// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    authority::{Claims, Configuration, Identity, limit, verify, wire},
};
use futures_util::{SinkExt, StreamExt};
use pgcf_native_gateway::{
    budget::{BudgetedStream, MemoryBudget, WireBudget},
    control::{self, HttpHead},
};
use pgcf_native_protocol::route::valid_websocket_key;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream, UdpSocket},
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, accept_async_with_config,
    tungstenite::{
        Message,
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
#[derive(Default)]
struct Admission {
    pending: usize,
    active: usize,
    closing: bool,
    nonces: HashMap<String, u64>,
}
pub struct Relay {
    configuration: Configuration,
    identity: Identity,
    memory: Arc<MemoryBudget>,
    state: Mutex<Admission>,
}
pub struct Running {
    pub relay: Arc<Relay>,
    pub address: SocketAddr,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.relay.state.lock().unwrap().closing = true;
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
impl Running {
    pub async fn close(mut self) {
        self.relay.state.lock().unwrap().closing = true;
        let _ = self.stop.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
struct Permit {
    relay: Arc<Relay>,
    active: bool,
}
impl Permit {
    fn activate(&mut self) {
        let mut state = self.relay.state.lock().unwrap();
        state.pending -= 1;
        state.active += 1;
        self.active = true;
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.relay.state.lock().unwrap();
        if self.active {
            state.active -= 1;
        } else {
            state.pending -= 1;
        }
    }
}
impl Relay {
    pub fn new(configuration: Configuration) -> Result<Arc<Self>, Error> {
        configuration.validate()?;
        if limit("frameBytes") as usize > pgcf_native_gateway::budget::MAX_STARTUP_BUFFER_BYTES {
            return Err("bootstrap frame bound incompatible with raw memory accounting".into());
        }
        let identity = configuration.identity()?;
        let memory = MemoryBudget::new(
            configuration.memory_bytes,
            configuration.connection_memory_bytes,
        );
        Ok(Arc::new(Self {
            configuration,
            identity,
            memory,
            state: Mutex::new(Admission::default()),
        }))
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    pub fn snapshot(&self) -> Value {
        let state = self.state.lock().unwrap();
        json!({"connections":state.active,"pending":state.pending,"nonces":state.nonces.len(),"memoryUsed":self.memory.used()})
    }
    fn reserve(self: &Arc<Self>) -> Result<Permit, u16> {
        let mut state = self.state.lock().unwrap();
        if state.closing || state.active + state.pending >= self.configuration.connections {
            return Err(503);
        }
        state.pending += 1;
        Ok(Permit {
            relay: self.clone(),
            active: false,
        })
    }
    fn nonce(&self, claims: &Claims) -> bool {
        let now = control::now() / 1000;
        if now >= claims.exp {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        state.nonces.retain(|_, expires| *expires > now);
        if state.nonces.contains_key(&claims.nonce)
            || state.nonces.len() >= limit("nonceEntries") as usize
        {
            return false;
        }
        state.nonces.insert(claims.nonce.clone(), claims.exp);
        true
    }
    pub async fn bind(configuration: Configuration) -> Result<Running, Error> {
        let relay = Self::new(configuration)?;
        let listener = TcpListener::bind(SocketAddr::new(
            relay.configuration.host,
            relay.configuration.port,
        ))
        .await?;
        let address = listener.local_addr()?;
        let (stop, mut receiver) = watch::channel(false);
        let service = relay.clone();
        let task = tokio::spawn(async move {
            let raw = Arc::new(Semaphore::new(service.configuration.connections * 2));
            let mut jobs = JoinSet::new();
            loop {
                tokio::select! {_=receiver.changed()=>break,Some(_)=jobs.join_next()=>{},accepted=listener.accept()=>{let Ok((socket,_))=accepted else{break;};let Ok(permit)=raw.clone().try_acquire_owned()else{drop(socket);continue;};let(service,stop)=(service.clone(),receiver.clone());jobs.spawn(async move{let _=service.socket(socket,stop,permit).await;});}}
            }
            service.state.lock().unwrap().closing = true;
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
        });
        Ok(Running {
            relay,
            address,
            stop,
            task: Some(task),
        })
    }
    async fn socket(
        self: Arc<Self>,
        mut socket: TcpStream,
        mut stop: watch::Receiver<bool>,
        raw: OwnedSemaphorePermit,
    ) -> Result<(), Error> {
        let head = tokio::select! {head=timeout(Duration::from_secs(5),control::read_head(&mut socket))=>match head{Ok(Ok(head))if head.end<=4096=>head,_=>return Ok(())},_=stop.changed()=>return Ok(())};
        if self.state.lock().unwrap().closing {
            return reject(&mut socket, 503).await;
        }
        if head.method == "GET" && head.path == wire("identityPath") {
            return control::reply(&mut socket, 200, serde_json::to_value(&self.identity)?).await;
        }
        let probe = head.method == "GET" && head.path == wire("probePath");
        let upgrade = head.method == "GET" && head.path == wire("path");
        if !probe && !upgrade {
            return reject(&mut socket, 404).await;
        }
        let mut permit = match self.reserve() {
            Ok(permit) => permit,
            Err(status) => return reject(&mut socket, status).await,
        };
        let Some(claims) = verify(
            head.one(wire("header")),
            &self.configuration,
            &self.identity,
            control::now(),
        ) else {
            return reject(&mut socket, 401).await;
        };
        if (probe && body_forbidden(&head)) || !self.nonce(&claims) {
            return reject(&mut socket, 401).await;
        }
        let mut baseline = self.memory.lease(&claims.nonce);
        if !baseline.grow(16 * 1024) {
            return reject(&mut socket, 503).await;
        }
        if probe {
            let outcome =
                tokio::select! {value=probe_target(&claims)=>value,_=stop.changed()=>return Ok(())};
            match outcome{Ok((source,outcome))=>return control::reply(&mut socket,200,json!({"version":1,"relay_epoch":self.identity.relay_epoch,"operation_id":claims.operation,"node_id":claims.node,"region_id":claims.region,"revision":claims.revision,"address":claims.target.address,"source":source.to_string(),"port":claims.target.port,"outcome":outcome,"observed_at":control::timestamp(control::now())})).await,Err(_)=>return reject(&mut socket,503).await}
        }
        if !websocket_upgrade(&head) {
            return reject(&mut socket, 401).await;
        }
        let wire_budget = WireBudget::new(self.memory.lease(&claims.nonce));
        let stream =
            BudgetedStream::new(socket, head.prefix, head.end, wire_budget.clone(), baseline);
        let config = WebSocketConfig::default()
            .read_buffer_size(4096)
            .write_buffer_size(4096)
            .max_write_buffer_size(2 * limit("frameBytes") as usize)
            .max_frame_size(Some(limit("frameBytes") as usize))
            .max_message_size(Some(limit("frameBytes") as usize));
        let mut websocket = timeout(
            Duration::from_secs(5),
            accept_async_with_config(stream, Some(config)),
        )
        .await??;
        drop(raw);
        permit.activate();
        let outcome = timeout(
            Duration::from_millis(self.configuration.session_ms),
            async {
                let address =
                    SocketAddr::new(claims.target.address.parse::<IpAddr>()?, claims.target.port);
                let mut upstream = timeout(
                    Duration::from_millis(limit("connectMs")),
                    TcpStream::connect(address),
                )
                .await??;
                upstream.set_nodelay(true)?;
                transfer(
                    &mut websocket,
                    &mut upstream,
                    &wire_budget,
                    &self.memory,
                    &claims.nonce,
                    &mut stop,
                )
                .await
            },
        )
        .await;
        let _ = timeout(Duration::from_millis(500), websocket.close(None)).await;
        match outcome {
            Ok(value) => value,
            Err(_) => Err("bootstrap relay session expired".into()),
        }
    }
}
fn body_forbidden(head: &HttpHead) -> bool {
    head.has("transfer-encoding")
        || (head.has("content-length") && head.one("content-length") != Some("0"))
}
fn websocket_upgrade(head: &HttpHead) -> bool {
    head.one("upgrade")
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
        && head.one("connection").is_some_and(|v| {
            v.split(',')
                .any(|v| v.trim().eq_ignore_ascii_case("upgrade"))
        })
        && head.one("sec-websocket-version") == Some("13")
        && head
            .one("sec-websocket-key")
            .is_some_and(valid_websocket_key)
}
async fn reject(socket: &mut TcpStream, status: u16) -> Result<(), Error> {
    timeout(
        Duration::from_millis(500),
        socket.write_all(
            format!("HTTP/1.1 {status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                .as_bytes(),
        ),
    )
    .await??;
    let _ = socket.shutdown().await;
    Ok(())
}
async fn probe_target(claims: &Claims) -> Result<(IpAddr, &'static str), Error> {
    let target: IpAddr = claims.target.address.parse()?;
    let any = if target.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let udp = UdpSocket::bind(any).await?;
    timeout(
        Duration::from_secs(1),
        udp.connect(SocketAddr::new(target, claims.target.port)),
    )
    .await??;
    let source = udp.local_addr()?.ip();
    if control::now() / 1000 >= claims.exp {
        return Err("bootstrap probe expired".into());
    }
    let tcp = if source.is_ipv4() {
        TcpSocket::new_v4()?
    } else {
        TcpSocket::new_v6()?
    };
    tcp.bind(SocketAddr::new(source, 0))?;
    let outcome = match timeout(
        Duration::from_secs(3),
        tcp.connect(SocketAddr::new(target, claims.target.port)),
    )
    .await
    {
        Ok(Ok(stream)) => {
            if stream.local_addr()?.ip() != source {
                return Err("bootstrap probe source changed".into());
            }
            "connected"
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => "refused",
        Err(_) => "timed_out",
        _ => return Err("bootstrap probe inconclusive".into()),
    };
    Ok((source, outcome))
}
async fn transfer(
    websocket: &mut WebSocketStream<BudgetedStream>,
    upstream: &mut TcpStream,
    wire_budget: &WireBudget,
    memory: &Arc<MemoryBudget>,
    nonce: &str,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), Error> {
    let mut read = vec![0; 8192];
    let mut incoming = 0u64;
    let mut controls = 0u64;
    let mut bytes = 0u64;
    loop {
        tokio::select! {_=stop.changed()=>break,message=websocket.next()=>match message{
         Some(Ok(Message::Binary(value)))=>{let lease=wire_budget.take_message()?;incoming+=1;bytes=bytes.checked_add(value.len()as u64).ok_or("bootstrap byte count overflow")?;if incoming>limit("incomingFrames")||bytes>limit("totalBytes"){return Err("bootstrap byte or message bound exceeded".into());}upstream.write_all(&value).await?;drop(lease);},
         Some(Ok(Message::Text(_)))=>{let _=wire_budget.take_message()?;return Err("bootstrap relay requires binary frames".into());},
         Some(Ok(Message::Ping(value)))=>{controls+=1;if controls>limit("controlFrames"){return Err("bootstrap control bound exceeded".into());}websocket.send(Message::Pong(value)).await?;},
         Some(Ok(Message::Pong(_)))=>{controls+=1;if controls>limit("controlFrames"){return Err("bootstrap control bound exceeded".into());}},
         Some(Ok(Message::Close(_)))|None=>break,Some(Err(error))=>return Err(error.into()),_=>{}
        },result=upstream.read(&mut read)=>{let count=result?;if count==0{let _=websocket.close(Some(CloseFrame{code:CloseCode::Normal,reason:"".into()})).await;break;}bytes=bytes.checked_add(count as u64).ok_or("bootstrap byte count overflow")?;if bytes>limit("totalBytes"){return Err("bootstrap byte bound exceeded".into());}let mut lease=memory.lease(nonce);if !lease.grow(2*count+256){return Err("bootstrap memory bound exceeded".into());}websocket.send(Message::Binary(read[..count].to_vec().into())).await?;drop(lease);}}
    }
    let _ = upstream.shutdown().await;
    Ok(())
}
