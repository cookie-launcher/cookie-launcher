#!/bin/bash
# ==============================================================================
# CookieLauncher Windows Setup.exe (.exe / NSIS) derleme yardımcısı
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "=========================================================="
echo "CookieLauncher Windows Setup.exe derleyicisi"
echo "=========================================================="

if [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* || "${OSTYPE:-}" == win32* ]]; then
  echo "Windows ortamı algılandı; NSIS paketi derleniyor..."
  npm run tauri:build
  echo "Çıktı: src-tauri/target/release/bundle/nsis/"
else
  echo "Bu betik Windows üzerinde çalıştırılmalıdır."
  echo ""
  echo "Windows'ta:"
  echo "  npm run tauri:build"
  echo ""
  echo "veya GitHub Actions üzerinden .github/workflows/release.yml kullanın."
  echo "Linux'tan cross-compile için:"
  echo "  rustup target add x86_64-pc-windows-msvc"
  echo "  cargo tauri build --target x86_64-pc-windows-msvc"
fi
