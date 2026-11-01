//! Command line entry point for the security gRPC service.

use practacu_security::transport::grpc::{
    argon2_limits, pb::security_service_server::SecurityServiceServer, SecurityServer,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = std::env::var("SECURITY_GRPC_BIND").unwrap_or_else(|_| "127.0.0.1:9001".to_string());
    let socket: std::net::SocketAddr = addr.parse()?;

    // Resolve the Argon2 bounds once at startup and say them out loud: they are what
    // stops a burst of unauthenticated logins from pinning gigabytes and starving the
    // runtime (which would fail the whole API closed).
    let limits = argon2_limits();
    println!(
        "practacu-security argon2: concurrency={} timeout={}ms",
        limits.concurrency,
        limits.timeout.as_millis()
    );
    println!("practacu-security listening on {socket}");

    tonic::transport::Server::builder()
        .add_service(SecurityServiceServer::new(SecurityServer))
        .serve(socket)
        .await?;

    Ok(())
}