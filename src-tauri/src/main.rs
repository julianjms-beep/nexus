// NEXUS desktop shell: starts the Node core (127.0.0.1 only), then opens a native window on it.
// The core is the single source of truth for permissions; this shell adds no privileges.
use std::{net::TcpStream, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, RunEvent};

struct Core(Mutex<Option<Child>>);

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
            let data = app.path().app_data_dir()?.join("core");
            std::fs::create_dir_all(&data)?;
            let port = 7777;
            let child = Command::new("node")
                .args(["--experimental-transform-types", "core/src/server.ts"])
                .current_dir(&root)
                .env("NEXUS_DATA", &data).env("NEXUS_PORT", port.to_string())
                .env("NEXUS_EXIT_ON_STDIN_CLOSE","1").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|e| format!("cannot start node core: {e}"))?;
            app.manage(Core(Mutex::new(Some(child))));
            for _ in 0..100 {
                if TcpStream::connect(("127.0.0.1", port)).is_ok() { break; }
                std::thread::sleep(Duration::from_millis(100));
            }
            let token = std::fs::read_to_string(data.join("token"))?.trim().to_string();
            let url = format!("http://127.0.0.1:{port}/?token={token}");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
                .title("NEXUS").inner_size(1100.0, 780.0).build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building NEXUS");
    app.run(|h, e| {
        if let RunEvent::Exit = e {
            if let Some(c) = h.try_state::<Core>() { if let Some(mut ch) = c.0.lock().unwrap().take() { let _ = ch.kill(); } }
        }
    });
}
