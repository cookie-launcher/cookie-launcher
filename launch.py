#!/usr/bin/env python3
import json
import os
import sys
import time
import subprocess
import urllib.request
import webbrowser

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_SCRIPT = os.path.join(PROJECT_DIR, "backend", "server.py")
PORT = 18420
URL = f"http://127.0.0.1:{PORT}"
API_VERSION = 15


def backend_health():
    """Yalnızca güncel API sürümüne sahip kendi backend'imizi kabul et."""
    try:
        with urllib.request.urlopen(f"{URL}/api/health", timeout=1) as r:
            if r.status != 200:
                return False
            data = json.loads(r.read().decode("utf-8"))
            return int(data.get("api_version") or 0) >= API_VERSION
    except Exception:
        return False


def start_backend():
    if backend_health():
        print(f"✓ CookieLauncher API zaten http://127.0.0.1:{PORT} üzerinde çalışıyor.")
        return None
    print("🚀 CookieLauncher arka plan servisi başlatılıyor...")
    proc = subprocess.Popen([sys.executable, BACKEND_SCRIPT], cwd=PROJECT_DIR)
    # Sunucunun ayağa kalkmasını bekle (en fazla 4 saniye)
    for _ in range(20):
        time.sleep(0.2)
        if backend_health():
            print(f"✓ Sunucu hazır: {URL}")
            return proc
    print("⚠️ Sunucu yanıt vermedi; başlatma iptal ediliyor.")
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
    return None


def open_app_window():
    print(f"🌐 CookieLauncher GUI açılıyor: {URL}")

    # 1. Chrome / Chromium App Modu dene (Frameless pencereli görünüm)
    for browser in ["google-chrome", "chromium", "chromium-browser", "brave"]:
        try:
            subprocess.Popen([browser, f"--app={URL}", "--window-size=1100,750"])
            return
        except FileNotFoundError:
            pass

    # 2. Firefox Yeni Pencere dene
    try:
        subprocess.Popen(["firefox", "--new-window", URL])
        return
    except FileNotFoundError:
        pass

    # 3. Varsayılan sistem tarayıcısı
    webbrowser.open(URL)


def main():
    print("=" * 60)
    print("🍪 COOKIELAUNCHER v3.1.0")
    print("=" * 60)
    backend_proc = None
    try:
        backend_proc = start_backend()
        if not backend_health():
            print("Backend sağlıklı değil; GUI açılmıyor.")
            return
        open_app_window()
        print("\n💡 Native derleme: 'npm run tauri:build'")
        print("   Kapatmak için Ctrl+C.")
        if backend_proc:
            backend_proc.wait()
    except KeyboardInterrupt:
        print("\nKapatılıyor...")
    finally:
        if backend_proc:
            backend_proc.terminate()
            try:
                backend_proc.wait(timeout=4)
            except subprocess.TimeoutExpired:
                backend_proc.kill()
                backend_proc.wait()


if __name__ == "__main__":
    main()
