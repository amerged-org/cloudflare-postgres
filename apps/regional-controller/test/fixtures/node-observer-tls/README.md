# Public test-only TLS fixture

This deliberately public P-256 key and self-signed certificate serve only the local HTTPS/WebSocket integration fixture. The certificate covers localhost and 127.0.0.1 and supports mutual test TLS. They were generated for these tests with OpenSSL; no installation credentials or environment values were copied. Never use this known key for an installation or a public service.
