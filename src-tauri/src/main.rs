// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::net::TcpStream;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// backend/server.py ile ayni olmali.
const API_VERSION: u64 = 15;
const BACKEND_PORTS: [u16; 6] = [18420, 18421, 18422, 18423, 18424, 18425];

static BACKEND_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// Calisan backend'in guncel API surumune sahip olup olmadigini kontrol eder.
fn backend_health_ok(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(350)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    let request = format!(
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let body_start = response.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
    let body = &response[body_start..];
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(json) => json
            .get("api_version")
            .and_then(|v| v.as_u64())
            .map(|v| v == API_VERSION)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Guncel API surumune sahip calisan bir backend portu bulur.
fn find_backend_port() -> Option<u16> {
    BACKEND_PORTS
        .iter()
        .copied()
        .find(|port| backend_health_ok(*port))
}

/// Backend'in bulunabilecegi tum kok dizinleri dondurur.
fn search_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
            // macOS .app paketi: Tauri kaynaklari Contents/Resources icine koyar.
            if let Some(contents) = dir.parent() {
                roots.push(contents.join("Resources"));
                roots.push(contents.join("Resources").join("backend"));
            }
            // target/release -> target -> src-tauri -> proje koku (yalnizca dev)
            if cfg!(debug_assertions) {
                if let Some(p1) = dir.parent() {
                    if let Some(p2) = p1.parent() {
                        if let Some(p3) = p2.parent() {
                            roots.push(p3.to_path_buf());
                        }
                    }
                }
            }
        }
    }

    // Yalnizca gelistirme modunda calisma dizinini ara. Release'te cwd'den
    // backend calistirmak, guvenilmeyen bir klasorden kod calistirilmasina yol acar.
    if cfg!(debug_assertions) {
        if let Ok(cwd) = std::env::current_dir() {
            roots.push(cwd.clone());
            roots.push(cwd.join(".."));
        }
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    }

    // Linux paket kurulumlari (deb/AppImage)
    if let Ok(appdir) = std::env::var("APPDIR") {
        roots.push(PathBuf::from(&appdir).join("usr/lib"));
        roots.push(PathBuf::from(&appdir).join("usr/lib/CookieLauncher"));
    }
    roots.push(PathBuf::from("/usr/lib/CookieLauncher"));
    roots.push(PathBuf::from("/usr/lib/cookie-launcher"));

    roots
}

/// PyInstaller ile paketlenmis standalone backend calistirilabilirini arar.
fn find_backend_binary() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["cookielauncher-core.exe", "cookie-launcher-core.exe"]
    } else {
        &["cookielauncher-core", "cookie-launcher-core"]
    };

    for root in search_roots() {
        for sub in ["backend", "resources/backend", "resources", ""] {
            for name in names {
                let candidate = if sub.is_empty() {
                    root.join(name)
                } else {
                    root.join(sub).join(name)
                };
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Python ile calistirilacak backend script'ini arar (paketlenmis exe yoksa yedek).
fn find_backend_script() -> Option<PathBuf> {
    for root in search_roots() {
        for sub in ["backend/server.py", "../backend/server.py"] {
            let candidate = root.join(sub);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Platforma gore Python komut adaylari (Windows: py -3, python, python3).
fn python_candidates() -> Vec<(&'static str, Vec<&'static str>)> {
    if cfg!(windows) {
        vec![("py", vec!["-3"]), ("python", vec![]), ("python3", vec![])]
    } else {
        vec![("python3", vec![]), ("python", vec![])]
    }
}

fn spawn_backend(command: &mut Command) -> std::io::Result<Child> {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        // Kendi process group'unda baslat: cleanup'ta tum agaci durdurabilelim.
        command.process_group(0);
    }
    command.spawn()
}

/// Backend'i baslatir ve saglikli bir port bulana kadar bekler.
fn start_backend_if_needed() -> Option<u16> {
    if let Some(port) = find_backend_port() {
        println!("CookieLauncher backend API zaten calisiyor (port {port}).");
        return Some(port);
    }

    let mut spawned = false;

    // 1. Tercih: paketlenmis standalone core (Python gerektirmez)
    if let Some(binary) = find_backend_binary() {
        println!("Starting bundled CookieLauncher core: {:?}", binary);
        let mut cmd = Command::new(&binary);
        if let Some(parent) = binary.parent() {
            cmd.current_dir(parent);
        }
        match spawn_backend(&mut cmd) {
            Ok(child) => {
                if let Ok(mut lock) = BACKEND_CHILD.lock() {
                    *lock = Some(child);
                }
                spawned = true;
            }
            Err(e) => eprintln!("Bundled backend baslatilamadi, Python denenecek: {e}"),
        }
    }

    // 2. Yedek: Python script (python3 / python / py -3)
    if !spawned {
        if let Some(script) = find_backend_script() {
            let working_dir = script
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf());

            for (program, prefix) in python_candidates() {
                let mut args: Vec<String> = prefix.iter().map(|s| s.to_string()).collect();
                args.push(script.to_string_lossy().to_string());

                let mut cmd = Command::new(program);
                cmd.args(&args);
                if let Some(dir) = &working_dir {
                    cmd.current_dir(dir);
                }

                match spawn_backend(&mut cmd) {
                    Ok(child) => {
                        if let Ok(mut lock) = BACKEND_CHILD.lock() {
                            *lock = Some(child);
                        }
                        println!("Backend spawned with '{}' -> {:?}", program, script);
                        spawned = true;
                        break;
                    }
                    Err(_) => continue,
                }
            }
        } else {
            eprintln!("CookieLauncher backend bulunamadi (cookielauncher-core veya backend/server.py).");
            eprintln!("Aranan kok dizinler: {:?}", search_roots());
            eprintln!("Platform: {}", std::env::consts::OS);
        }
    }

    if !spawned {
        return None;
    }

    // Spawn basarili olsa bile backend henuz hazir olmayabilir; kisa sure bekle.
    for _ in 0..30 {
        if let Some(port) = find_backend_port() {
            println!("Backend healthy on port {port}.");
            return Some(port);
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    eprintln!("Backend 6 saniye icinde saglikli yanit vermedi; surec kapatiliyor.");
    cleanup_backend();
    None
}

fn cleanup_backend() {
    let mut child = match BACKEND_CHILD.lock() {
        Ok(mut lock) => lock.take(),
        Err(_) => None,
    };
    if let Some(child) = child.as_mut() {
        let pid = child.id();
        #[cfg(unix)]
        unsafe {
            // Negatif pid = process group; PyInstaller/Python alt surecleri de gider.
            libc::killpg(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        // Nazik kapanma icin kisa bekle, sonra zorla.
        for _ in 0..10 {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        #[cfg(unix)]
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn install_signal_cleanup() {
    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;
    if let Ok(mut signals) = Signals::new([SIGINT, SIGTERM]) {
        std::thread::spawn(move || {
            for _ in signals.forever() {
                cleanup_backend();
                std::process::exit(0);
            }
        });
    }
}

fn main() {
    // Panik halinde de backend'i yetim birakma.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        cleanup_backend();
        default_hook(info);
    }));

    #[cfg(unix)]
    install_signal_cleanup();

    let _backend_port = start_backend_if_needed();

    let app = tauri::Builder::default()
        .setup(|_app| Ok(()))
        .build(tauri::generate_context!())
        .expect("Tauri uygulamasi baslatilirken hata olustu");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            cleanup_backend();
        }
    });

    // RunEvent::Exit gelmezse diye son guvenlik agi.
    cleanup_backend();
}
