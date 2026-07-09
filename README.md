# 🎵 OpenWrt-Music-Box: Audiophile-Grade Music Server for OpenWrt

Turn your idle OpenWrt Router or Set-Top Box (STB) into a High-End, Bit-Perfect Music Streamer.

OpenWrt-Music-Box is a lightweight, Dockerized music player tailored specifically for OpenWrt environments. It bypasses the standard Linux audio resampling, delivering pure, untouched audio data directly to your USB DAC. Combined with seamless Bluetooth A2DP support and a smart local library manager, it's the ultimate audio engine for your homelab.

---

## ✨ Key Features

* 🎧 **Bit-Perfect Audio Output:** Delivers pure, untouched digital audio (e.g., 24-bit/96kHz) directly to your USB DAC without system resampling.
* 📡 **Bluetooth A2DP Support:** Custom integrated `bluealsa` allows seamless pairing and streaming to your TWS or Bluetooth Speakers right from the Web UI.
* 🗂️ **Smart Background Scanner:** Asynchronous deep-scanning of your internal/external HDDs (`/mnt`). Automatically extracts ID3 tags using `mutagen` and stores them in a lightning-fast SQLite WAL-mode database.
* 🌐 **Responsive Web UI:** Control playback, manage queues, browse folders, and pair Bluetooth devices from any browser.
* ☁️ **YouTube Music & Lyrics API:** Integrated with `ytmusicapi` for cloud streaming and `LRCLIB` for real-time synced lyrics.
* 🐳 **Fully Dockerized:** Runs in an isolated, lightweight Debian container, keeping your OpenWrt host perfectly clean.
* 🎚️ **10-Band Equalizer + Crossfeed:** Built-in parametric EQ with 16 presets and binaural crossfeed for headphones.
* 🌐 **Browser Play Mode:** Stream audio directly in your browser without server-side playback.
* 📁 **File Upload:** Upload audio files via the Web UI for instant playback.
* 📱 **PWA Ready:** Install as a Progressive Web App on your phone for a native-like experience.

---

## 🚀 One-Command Installation

**Satu perintah untuk SEMUA platform — install, start, & LuCI setup otomatis:**

```bash
git clone https://github.com/cngreenapple/openwrt-music-box.git && cd openwrt-music-box && chmod +x install.sh && ./install.sh
```

Script akan **otomatis**:
| Step | Aksi |
|------|------|
| 1-6 | Install semua dependencies & Python packages |
| 7 | **Auto-start service** — Docker (OpenWrt) atau background (Debian/Alpine) |
| 8 | **Auto-setup LuCI** — jika terdeteksi OpenWrt, langsung pasang tab di panel admin |
| ✓ | **Verifikasi** — cek apakah service sudah running di port **2030** |

Akses di: **http://localhost:2030** atau **http://<ip-router>:2030**

---

## 🛠️ Prerequisites

1.  **Hardware:** An OpenWrt Router/STB with a USB port.
2.  **Audio Output:** A USB DAC (Digital-to-Analog Converter) or a Bluetooth Audio Device.
3.  **Software:** OpenWrt, Debian/Ubuntu, or Alpine Linux with Internet access.

---

## 🚀 Installation Guide

### ✅ All-in-One Installer (Recommended)

**Satu perintah untuk semua platform** (Debian/Ubuntu, OpenWrt, Alpine):

```bash
git clone https://github.com/cngreenapple/openwrt-music-box.git
cd openwrt-music-box
chmod +x install.sh && ./install.sh
```

Script akan mendeteksi sistem Anda dan melakukan semuanya secara otomatis:

| Step | Deskripsi |
|------|-----------|
| **1/6** | 🔍 Deteksi OS — otomatis (apt, opkg, apk) |
| **2/6** | 📦 Install/update system dependencies — ffmpeg, bluez, alsa, socat, curl, git (skip yang sudah ada). Jika `mpv` tidak tersedia (OpenWrt), otomatis install Docker sebagai gantinya |
| **3/6** | 🐍 Setup Python virtual environment `venv/`. Jika `python3-venv` tidak tersedia, fallback ke install system-wide |
| **4/6** | 📚 Install/update Python packages — Flask, ytmusicapi, yt-dlp, mutagen, requests |
| **5/6** | ⬇️ Download/update yt-dlp binary terbaru untuk YouTube streaming |
| **6/6** | ✅ Final setup — permissions, FontAwesome assets, verifikasi komponen, buat `run.sh` |

> **Catatan:** Script aman dijalankan berulang kali — komponen yang sudah ada akan di-skip, yang perlu update akan diperbarui.

**Setelah selesai:**
```bash
# Di Debian/Ubuntu (dengan mpv):
./run.sh

# Di OpenWrt (tanpa mpv, via Docker):
OWRTMB_PORT=2030 docker-compose up -d --build

# Atau langsung:
source venv/bin/activate && python3 app.py
```

Akses di: **http://localhost:2030** atau **http://<ip-router>:2030**

---

### 🐳 Metode Docker (Untuk OpenWrt)

#### Step 1: Install OpenWrt Dependencies

Jalankan di SSH terminal OpenWrt Anda:

```bash
opkg update
opkg install kmod-usb-audio bluez-daemon dockerd docker docker-compose git git-http
```

Aktifkan service:
```bash
/etc/init.d/dockerd enable && /etc/init.d/dockerd start
/etc/init.d/bluetoothd enable && /etc/init.d/bluetoothd start
```

**⚠️ PENTING: Konfigurasi DNS Docker Daemon**
Di OpenWrt, Docker build container sering gagal resolve DNS. Konfigurasikan **daemon.json**:

```bash
mkdir -p /etc/docker
cat << 'EOF' > /etc/docker/daemon.json
{
  "dns": ["8.8.8.8", "1.1.1.1"],
  "iptables": false
}
EOF
/etc/init.d/dockerd restart
```

> **Tanpa konfigurasi ini, `docker-compose up -d --build` akan gagal dengan error `Temporary failure resolving 'deb.debian.org'`**

#### Step 2: Host Preparation (CRITICAL FOR BLUETOOTH)

Buat D-Bus policy agar bluealsa di container bisa komunikasi dengan host:

```bash
cat << 'EOF' > /etc/dbus-1/system.d/bluealsa.conf
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="root">
    <allow own="org.bluealsa"/>
    <allow send_destination="org.bluealsa"/>
  </policy>
  <policy context="default">
    <allow send_destination="org.bluealsa"/>
  </policy>
</busconfig>
EOF
/etc/init.d/dbus reload
/etc/init.d/bluetoothd restart
```

#### Step 3: Clone & Run

```bash
git clone https://github.com/cngreenapple/openwrt-music-box.git
cd openwrt-music-box
OWRTMB_PORT=2030 docker-compose up -d --build
```

> **Note:** Container mount `/dev/snd` dan `/var/run/dbus` untuk akses audio hardware dan Bluetooth.

---

### 📦 Metode Manual (Semua Platform)

```bash
git clone https://github.com/cngreenapple/openwrt-music-box.git
cd openwrt-music-box

# Debian/Ubuntu:
sudo apt update
sudo apt install -y python3 python3-pip python3-venv mpv ffmpeg bluez bluez-alsa-utils alsa-utils psmisc curl git socat

# ATAU OpenWrt:
opkg update
opkg install python3 python3-pip ffmpeg bluez-daemon kmod-usb-audio alsa-utils curl git socat

# ATAU Alpine:
sudo apk update
sudo apk add python3 py3-pip mpv ffmpeg bluez alsa-utils curl git socat

# Install Python packages
pip3 install -r requirements.txt

# Setup
chmod +x play.sh toggle_output.sh
python3 app.py
```

---

## ⚙️ Configuration via Environment Variables

OpenWrt-Music-Box can be configured using the following environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OWRTMB_PORT` | `2030` | Web UI port |
| `OWRTMB_HOST` | `0.0.0.0` | Bind address |
| `OWRTMB_LOG_LEVEL` | `INFO` | Log level (DEBUG, INFO, WARNING, ERROR) |

Example:
```bash
# Run with custom port and debug logging
OWRTMB_PORT=8080 OWRTMB_LOG_LEVEL=DEBUG python3 app.py
```

Or in `docker-compose.yml`:
```yaml
environment:
  - OWRTMB_PORT=2030
  - OWRTMB_LOG_LEVEL=DEBUG
```

---

## 🖥️ OpenWrt LuCI Integration (Optional but Recommended)

Want to access OpenWrt-Music-Box directly from your OpenWrt admin panel? Run this snippet on your OpenWrt SSH:

```bash
cat <<'EOF' >/usr/lib/lua/luci/controller/openwrtmusicbox.lua
module("luci.controller.openwrtmusicbox", package.seeall)
function index()
    entry({"admin", "openwrtmusicbox"}, template("openwrtmusicbox"), _("OpenWrt-Music-Box"), 90).leaf=true
end
EOF

cat <<'EOF' >/usr/lib/lua/luci/view/openwrtmusicbox.htm
<%+header%>
<div class="cbi-map">
    <iframe id="owmb-player" style="width: 100%; min-height: 90vh; border: none; border-radius: 2px;"></iframe>
</div>
<script type="text/javascript">
    document.getElementById("owmb-player").src = window.location.protocol + "//" + window.location.hostname + ":2030";
</script>
<%+footer%>
EOF

rm -rf /tmp/luci-*
```

---

## 📖 Usage

### 🎮 Player Controls
1. **Play Music:** Search YouTube Music via the search bar, paste a YouTube URL, or browse local files in Media Center.
2. **Play Mode:** Choose between **Server mode** (mpv plays audio on the device) or **Browser mode** (audio streams to your browser).
3. **Queue Management:** View, reorder (click to jump), shuffle, and clear your queue.
4. **Equalizer:** Drag the 10-band parametric EQ knobs, or select from **16 presets** (Bass, Rock, Pop, Jazz, Vocal, Metal, etc.)
5. **Balance & Crossfeed:** Adjust left/right balance, mute individual channels, or enable binaural crossfeed for headphones.

### 🎤 Lyrics
- Click the microphone icon to fetch real-time synced lyrics from LRCLIB.

### 🔊 Audio Output
- **Line Out (Jack):** Default analog output via 3.5mm jack.
- **HDMI:** Digital audio via HDMI.
- **Bluetooth:** Scan, pair, and stream to TWS or Bluetooth speakers.

### 📁 File Upload
- Upload audio files directly from the Media Center tab — supports MP3, FLAC, WAV, M4A, OGG, OPUS, AAC, DSF, DFF.

### ⏱️ Sleep Timer
- Set a timer (15min, 30min, 1 hour) to auto-stop playback.

### 📱 PWA
- Open in browser → Add to Home Screen for a native app-like experience.

---

## ⚙️ Tech Stack

* **Backend:** Python 3.11+ (Flask 3.x)
* **Audio Engine:** MPV & BlueALSA
* **YouTube Streaming:** yt-dlp (Python library) + ytmusicapi + mpv built-in ytdl
* **Database:** SQLite3 (WAL Mode for high concurrency)
* **Metadata:** Mutagen
* **Frontend:** Vanilla JS, FontAwesome 6, PWA
* **Container:** Multi-stage Docker build (Debian Bookworm)

---

## 📁 Project Structure

```
openwrt-music-box/
├── app.py                # Main Flask application (backend logic & API routes)
├── library.py            # SQLite library manager (WAL mode)
├── bt_manager.py         # Bluetooth manager class
├── play.sh               # MPV audio player wrapper
├── toggle_output.sh      # Audio output switcher
├── install.sh            # All-in-one installer (6 steps)
├── run.sh                # Convenience start script (auto-generated)
├── Dockerfile            # Multi-stage Docker build
├── docker-compose.yml    # Docker Compose configuration
├── requirements.txt      # Python dependencies
├── .gitignore            # Git ignore rules
├── static/
│   ├── js/script.js      # Frontend application logic
│   ├── sw.js             # Service Worker (PWA offline cache)
│   ├── css/              # Stylesheets
│   ├── img/              # Images & icons
│   ├── covers/           # Extracted album covers cache
│   └── webfonts/         # FontAwesome 6 fonts
└── templates/
    └── index.html        # Single-page web UI
```

---

## 🧹 Logging

- **File:** `owrt_musicbox.log` di direktori aplikasi (otomatis dibuat)
- **Stdout:** Juga tampil di terminal / `docker logs`
- **Level:** Atur via `OWRTMB_LOG_LEVEL` (DEBUG, INFO, WARNING, ERROR)

Contoh melihat log:
```bash
tail -f owrt_musicbox.log
docker logs -f openwrt-music-box
```

---

## 🐛 Troubleshooting

| Masalah | Solusi |
|---------|--------|
| **mpv not found** | Di OpenWrt, mpv tidak tersedia. Gunakan metode Docker: `OWRTMB_PORT=2030 docker-compose up -d --build` |
| **sudo: command not found** | OpenWrt tidak punya sudo. Installer sudah otomatis handle ini via `run_cmd()` |
| **Python venv error** | Jika `python3-venv` tidak bisa diinstall, installer akan fallback ke install system-wide |
| **YouTube playback error** | Pastikan package `yt-dlp` terinstall di Python: `pip3 list \| grep yt-dlp`. Jika tidak, jalankan `pip3 install yt-dlp` |
| **Bluetooth not working** | Pastikan D-Bus policy sudah dibuat (lihat Step 2 Docker) |
| **No audio** | Periksa output device di Web UI (Jack/HDMI/Bluetooth). Pastikan USB DAC terdeteksi |
| **Docker build gagal: DNS resolution error** | Masalah umum di OpenWrt. Build container tidak bisa resolve `deb.debian.org`. Solusi: (1) Pastikan file `docker-compose.yml` sudah punya `network: host` di bagian build. (2) Coba set DNS host: `echo "nameserver 8.8.8.8" > /etc/resolv.conf && /etc/init.d/dockerd restart`. (3) Atau gunakan perintah build manual: `cd /openwrt-music-box && docker build --network host -t openwrt-music-box . && OWRTMB_PORT=2030 docker-compose up -d` |
| **Docker build lambat / timeout** | Build pertama perlu download base image Python + Debian (~300MB). Pastikan koneksi internet stabil. Bisa memakan waktu 5-15 menit tergantung kecepatan internet. |
| **install.sh berhenti di tengah** | Koneksi internet terputus saat download. Jalankan ulang: `./install.sh` — komponen yang sudah berhasil akan di-skip |
| **Docker compose warning: "buildx isn't installed"** | Warning tidak berbahaya. Build tetap jalan. Untuk menghilangkannya, install buildx: `opkg install docker-buildx` |

---

## 📝 License

This project is open-source and available under the MIT License. Feel free to fork, modify, and build upon it!