fn main() -> Result<(), Box<dyn std::error::Error>> {
    // protoc is not installed system wide; the vendored binary keeps the build
    // reproducible instead of depending on a machine level tool.
    if std::env::var("PROTOC").is_err() {
        if let Ok(path) = protoc_bin_vendored::protoc_bin_path() {
            std::env::set_var("PROTOC", path);
        }
    }

    let proto_dir = "../../packages/contracts/security/v1";

    tonic_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&[format!("{proto_dir}/security.proto")], &[proto_dir])?;

    println!("cargo:rerun-if-changed={proto_dir}/security.proto");
    Ok(())
}