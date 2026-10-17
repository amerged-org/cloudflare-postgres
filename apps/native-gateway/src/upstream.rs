// SPDX-License-Identifier: Apache-2.0
//! The connection to a database's PostgreSQL: TLS over TCP to a Pod (Kubernetes mode), or the
//! database's Unix socket on the node (local mode).
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpStream, UnixStream},
};
use tokio_rustls::client::TlsStream;

pub enum Upstream {
    Tls(Box<TlsStream<TcpStream>>),
    Unix(UnixStream),
}
impl Upstream {
    /// Whether bytes the gateway wrote still wait inside the stream: TLS records not yet on the
    /// socket. A Unix socket keeps nothing.
    pub fn queued(&self) -> bool {
        match self {
            Self::Tls(stream) => stream.get_ref().1.wants_write(),
            Self::Unix(_) => false,
        }
    }
}
impl From<TlsStream<TcpStream>> for Upstream {
    fn from(stream: TlsStream<TcpStream>) -> Self {
        Self::Tls(Box::new(stream))
    }
}
impl AsyncRead for Upstream {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(context, buffer),
            Self::Unix(stream) => Pin::new(stream).poll_read(context, buffer),
        }
    }
}
impl AsyncWrite for Upstream {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(context, bytes),
            Self::Unix(stream) => Pin::new(stream).poll_write(context, bytes),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(context),
            Self::Unix(stream) => Pin::new(stream).poll_flush(context),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(context),
            Self::Unix(stream) => Pin::new(stream).poll_shutdown(context),
        }
    }
}
