//! Command line entry point for the security gRPC service.

use practacu_security::transport::grpc::{
    pb::security_service_server::SecurityServiceServer, SecurityServer,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = std::env::var("SECURITY_GRPC_BIND").unwrap_or_else(|_| "127.0.0.1:9001".to_string());
    let socket: std::net::SocketAddr = addr.parse()?;

    println!("practacu-security listening on {socket}");

    tonic::transport::Server::builder()
        .add_service(SecurityServiceServer::new(SecurityServer))
        .serve(socket)
        .await?;

    Ok(())
}