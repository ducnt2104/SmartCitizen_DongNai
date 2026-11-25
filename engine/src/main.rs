use smartcitizen_cv_engine::build_router;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let port: u16 = env::var("CV_ENGINE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8001);
    let host = env::var("CV_ENGINE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let models_dir = env::var("CV_MODELS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let candidate = PathBuf::from("../models");
            if candidate.exists() {
                candidate
            } else {
                PathBuf::from("models")
            }
        });

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .expect("Invalid CV_ENGINE_HOST:CV_ENGINE_PORT");

    let app = build_router(models_dir.clone());
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("[rust-cv-engine] Không bind được {addr}: {e}"));

    println!(
        "[rust-cv-engine] SmartCitizen High-Speed CV & ONNX Engine đang lắng nghe tại http://{addr} (models: {})",
        models_dir.display()
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            println!("[rust-cv-engine] Đang tắt dịch vụ CV Engine...");
        })
        .await
        .expect("[rust-cv-engine] Server dừng bất thường");
}
