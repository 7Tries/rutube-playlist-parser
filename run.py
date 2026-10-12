import sys
import os

# Ensure UTF-8 output on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import socket
import webbrowser
import threading
import time
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

def find_available_port(start_port: int = 8000, max_attempts: int = 20) -> int:
    """Finds an open TCP port starting from start_port."""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start_port

def open_browser_delayed(url: str, delay: float = 1.0):
    def _open():
        time.sleep(delay)
        print(f"[*] Открываем браузер: {url}")
        webbrowser.open(url)
    threading.Thread(target=_open, daemon=True).start()

def main():
    import uvicorn
    port = find_available_port(8000)
    url = f"http://127.0.0.1:{port}"
    
    print("=" * 60)
    print(" [RUTUBE PLAYLIST PARSER] - СЕРВИС ПАРСИНГА ССЫЛОК RUTUBE")
    print("=" * 60)
    print(f" Сервер запущен по адресу: {url}")
    print(" Нажмите Ctrl+C для остановки сервера.")
    print("=" * 60)

    # Automatically open browser if not in headless environment
    if "--no-browser" not in sys.argv:
        open_browser_delayed(url, 1.2)

    uvicorn.run("backend.main:app", host="127.0.0.1", port=port, log_level="info")

if __name__ == "__main__":
    main()
