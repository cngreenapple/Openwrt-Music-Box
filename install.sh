#!/bin/bash
# ============================================
# Owrt-MusicBox All-in-One Installer
# ============================================
# ONE COMMAND: chmod +x install.sh && ./install.sh
# Install / Update otomatis — jalan berulang kali aman!
# ============================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
ALL_OK=true
OWRTMB_PORT=2030

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}       Owrt-MusicBox - Install / Update${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# ============================================
# UNINSTALL DULU
# ============================================
echo ""
echo -e "${YELLOW}---[0/7] Uninstall Previous ---${NC}"
if [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
    chmod +x "$SCRIPT_DIR/uninstall.sh"; cd "$SCRIPT_DIR"; ./uninstall.sh; echo ""; log_ok "Uninstall selesai"
else
    log_info "uninstall.sh tidak ditemukan"
fi

# ============================================
# GIT PULL
# ============================================
if [ -d "$SCRIPT_DIR/.git" ]; then
    log_info "Git pull update terbaru..."; cd "$SCRIPT_DIR"; git pull 2>&1 | tail -2
fi

# ============================================
# DOCKER CHECK
# ============================================
USE_DOCKER=false
if command -v docker &>/dev/null && docker ps &>/dev/null 2>&1; then USE_DOCKER=true; fi

# ============================================
# run.sh
# ============================================
cat > "$SCRIPT_DIR/run.sh" << 'RUNEOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f "$SCRIPT_DIR/venv/bin/activate" ]; then source "$SCRIPT_DIR/venv/bin/activate"; fi
python3 app.py
RUNEOF
chmod +x "$SCRIPT_DIR/run.sh"
log_ok "Created run.sh"

# ============================================
# STEP 1: Detect OS
# ============================================
echo ""; echo -e "${YELLOW}---[1/6] System Update & Package Manager ---${NC}"

detect_os() {
    if command -v apt &>/dev/null; then
        PKG_MANAGER="apt"; PKG_INSTALL="sudo apt install -y"; PKG_UPDATE="sudo apt update"
        IS_OPENWRT=false; HAS_MPV=true
    elif command -v opkg &>/dev/null; then
        PKG_MANAGER="opkg"; PKG_INSTALL="opkg install"; PKG_UPDATE="opkg update"
        IS_OPENWRT=true; HAS_MPV=false
    elif command -v apk &>/dev/null; then
        PKG_MANAGER="apk"; PKG_INSTALL="sudo apk add"; PKG_UPDATE="sudo apk update"
        IS_OPENWRT=false; HAS_MPV=true
    else
        log_error "No package manager found."; PKG_MANAGER="unknown"; IS_OPENWRT=false; HAS_MPV=false
    fi
    log_ok "Detected: $PKG_MANAGER"
}
detect_os

$PKG_UPDATE 2>&1 | tail -1 || log_warn "Update failed"

# ============================================
# STEP 2: System Dependencies
# ============================================
echo ""; echo -e "${YELLOW}---[2/6] System Dependencies ---${NC}"

install_pkg() { local pkg="$1"; local check="${2:-which $pkg}"; if eval "$check" &>/dev/null; then log_ok "$pkg already installed"; else log_info "Installing $pkg..."; $PKG_INSTALL "$pkg" 2>&1 | tail -1 || true; eval "$check" &>/dev/null && log_ok "$pkg installed" || { log_warn "Failed: $pkg"; ALL_OK=false; }; fi; }
run_cmd() { if command -v sudo &>/dev/null; then sudo "$@"; else "$@"; fi; }

if [ "$PKG_MANAGER" = "apt" ]; then
    for p in python3 python3-pip python3-venv mpv ffmpeg bluez bluez-alsa-utils alsa-utils psmisc curl git socat; do install_pkg "$p"; done
elif [ "$PKG_MANAGER" = "opkg" ]; then
    for p in python3 python3-pip ffmpeg bluez-daemon kmod-usb-audio alsa-utils curl git socat docker dockerd docker-compose; do install_pkg "$p"; done
    if ! /etc/init.d/dockerd running 2>/dev/null; then /etc/init.d/dockerd start 2>/dev/null || true; sleep 2; fi
elif [ "$PKG_MANAGER" = "apk" ]; then
    for p in python3 py3-pip mpv ffmpeg bluez alsa-utils curl git socat; do install_pkg "$p"; done
fi

if ! command -v pip3 &>/dev/null && command -v python3 &>/dev/null; then
    [ "$PKG_MANAGER" = "apt" ] && sudo apt install -y python3-pip 2>&1 | tail -1 || true
    [ "$PKG_MANAGER" = "opkg" ] && opkg install python3-pip 2>&1 | tail -1 || true
fi

# ============================================
# STEP 3: Python Virtual Environment
# ============================================
echo ""; echo -e "${YELLOW}---[3/6] Python Virtual Environment ---${NC}"

USE_VENV=true
if ! python3 -c "import venv" 2>/dev/null; then
    [ "$PKG_MANAGER" = "apt" ] && sudo apt install -y python3-venv 2>&1 | tail -1 || USE_VENV=false
    [ "$PKG_MANAGER" = "opkg" ] && opkg install python3-venv 2>/dev/null || USE_VENV=false
fi

if [ "$USE_VENV" = true ]; then
    [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/python3" ] && log_ok "venv exists" || { python3 -m venv "$VENV_DIR" && log_ok "venv created"; }
    source "$VENV_DIR/bin/activate" 2>/dev/null || true
    PIP_CMD="pip"; pip install --upgrade pip 2>&1 | tail -1 || true
else
    PIP_CMD="pip3"; command -v pip3 &>/dev/null || PIP_CMD="python3 -m pip"
fi

# ============================================
# STEP 4: Python Dependencies
# ============================================
echo ""; echo -e "${YELLOW}---[4/6] Python Dependencies ---${NC}"

$PIP_CMD install -r "$REQUIREMENTS" 2>&1 | tail -2 || $PIP_CMD install flask requests ytmusicapi mutagen 2>&1 | tail -2 || true

# Verifikasi
python3 -c "
import importlib.metadata, sys
pkgs = {'flask':'Flask','requests':'requests','ytmusicapi':'YTMusicAPI','mutagen':'Mutagen'}
for pkg, label in pkgs.items():
    try:
        v = importlib.metadata.version(pkg)
        print(f'  ✅ {label}=={v}')
    except:
        # Fallback: coba import langsung
        try:
            __import__(pkg)
            print(f'  ✅ {label} (terinstall, versi tidak terbaca)')
        except:
            print(f'  ❌ {label}')
" 2>/dev/null

# ============================================
# STEP 5: yt-dlp (Dengan Mirror + Fallback)
# ============================================
echo ""; echo -e "${YELLOW}---[5/6] yt-dlp (YouTube Downloader) ---${NC}"

YTDLP_BIN="/usr/local/bin/yt-dlp"
YTDLP_INSTALLED=false

# Cek apakah sudah ada
if command -v yt-dlp &>/dev/null; then
    log_ok "yt-dlp already: v$(yt-dlp --version 2>/dev/null || echo 'OK')"
    YTDLP_INSTALLED=true
fi

# Coba download dari berbagai source
download_ytdlp() {
    local url="$1"; local dest="$2"
    if command -v curl &>/dev/null; then
        run_cmd curl -sL --connect-timeout 15 --max-time 60 "$url" -o "$dest" 2>/dev/null && return 0
    fi
    if command -v wget &>/dev/null; then
        run_cmd wget -q --timeout=30 "$url" -O "$dest" 2>/dev/null && return 0
    fi
    return 1
}

if [ "$YTDLP_INSTALLED" = false ]; then
    log_info "Mencoba download yt-dlp..."
    
    # Mirror 1: jsDelivr CDN (cepat)
    log_info "  [1/4] jsDelivr CDN..."
    if download_ytdlp "https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt-dlp/yt-dlp" "$YTDLP_BIN"; then
        chmod a+rx "$YTDLP_BIN"
        if command -v yt-dlp &>/dev/null; then log_ok "yt-dlp via CDN"; YTDLP_INSTALLED=true; fi
    fi
    
    # Mirror 2: GitHub (official)
    if [ "$YTDLP_INSTALLED" = false ]; then
        log_info "  [2/4] GitHub releases..."
        if download_ytdlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "$YTDLP_BIN"; then
            chmod a+rx "$YTDLP_BIN"
            if command -v yt-dlp &>/dev/null; then log_ok "yt-dlp via GitHub"; YTDLP_INSTALLED=true; fi
        fi
    fi
    
    # Mirror 3: GitHub mirror (fastgit)
    if [ "$YTDLP_INSTALLED" = false ]; then
        log_info "  [3/4] FastGit mirror..."
        if download_ytdlp "https://hub.fastgit.xyz/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "$YTDLP_BIN"; then
            chmod a+rx "$YTDLP_BIN"
            if command -v yt-dlp &>/dev/null; then log_ok "yt-dlp via FastGit"; YTDLP_INSTALLED=true; fi
        fi
    fi
    
    # Fallback: pip install yt-dlp
    if [ "$YTDLP_INSTALLED" = false ]; then
        log_info "  [4/4] pip install yt-dlp..."
        $PIP_CMD install yt-dlp 2>&1 | tail -1 || true
        if command -v yt-dlp &>/dev/null; then log_ok "yt-dlp via pip"; YTDLP_INSTALLED=true; fi
    fi
    
    # Final: copy ke /usr/local/bin jika di-install via pip
    if command -v yt-dlp &>/dev/null && [ ! -f "$YTDLP_BIN" ]; then
        cp "$(which yt-dlp)" "$YTDLP_BIN" 2>/dev/null || true
    fi
    
    if [ "$YTDLP_INSTALLED" = false ]; then
        log_warn "yt-dlp gagal di semua mirror. YouTube playback mungkin tidak berfungsi."
        log_warn "Install manual: pip3 install yt-dlp"
    fi
fi

# Simpan yt-dlp di folder project juga sebagai backup
if command -v yt-dlp &>/dev/null && [ ! -f "$SCRIPT_DIR/bin/yt-dlp" ]; then
    mkdir -p "$SCRIPT_DIR/bin"
    cp "$(which yt-dlp)" "$SCRIPT_DIR/bin/yt-dlp" 2>/dev/null || true
    log_ok "yt-dlp dicopy ke project/bin/"
fi

# ============================================
# STEP 6: Final Setup
# ============================================
echo ""; echo -e "${YELLOW}---[6/6] Final Setup ---${NC}"

chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true
mkdir -p "$SCRIPT_DIR/data" "$SCRIPT_DIR/uploads"

if [ ! -f "$SCRIPT_DIR/static/css/all.min.css" ]; then
    log_info "Downloading FontAwesome..."; python3 "$SCRIPT_DIR/get_assets.py" 2>&1 | tail -1 || true
else
    log_ok "FontAwesome ready"
fi

# ============================================
# STEP 7: AUTO-START
# ============================================
echo ""; echo -e "${YELLOW}---[7/7] Auto-Start ---${NC}"

SERVICE_STARTED=false

if [ "$IS_OPENWRT" = true ] && [ "$USE_DOCKER" = true ]; then
    if [ ! -f /etc/docker/daemon.json ]; then
        mkdir -p /etc/docker
        cat > /etc/docker/daemon.json << 'DOCKERDNS'
{"dns":["8.8.8.8","1.1.1.1"],"iptables":false}
DOCKERDNS
        /etc/init.d/dockerd restart 2>/dev/null || true; sleep 2
    fi
    cd "$SCRIPT_DIR"
    log_info "Building Docker image..."
    OWRTMB_PORT=$OWRTMB_PORT docker-compose build 2>&1
    if [ $? -eq 0 ]; then
        OWRTMB_PORT=$OWRTMB_PORT docker-compose up -d 2>&1
        for i in 1 2 3 4 5 6 7 8; do
            sleep 2
            if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "owrt-musicbox"; then
                log_ok "Container RUNNING!"; SERVICE_STARTED=true; break
            fi
        done
    else
        log_warn "Build gagal. Manual: cd $SCRIPT_DIR && OWRTMB_PORT=$OWRTMB_PORT docker-compose up -d --build"
    fi
else
    log_info "Starting service..."; cd "$SCRIPT_DIR"
    nohup ./run.sh > /tmp/owrt-musicbox.log 2>&1 &
    sleep 2; SERVICE_STARTED=true; log_ok "Service started (PID: $!)"
fi

# ============================================
# STEP 8: LuCI
# ============================================
if [ "$IS_OPENWRT" = true ] && [ -d /usr/lib/lua/luci ]; then
    echo ""; echo -e "${YELLOW}---[+] LuCI Integration ---${NC}"
    cat > /usr/lib/lua/luci/controller/owrtmusicbox.lua << 'LUCI_CTRL'
module("luci.controller.owrtmusicbox", package.seeall)
function index()
    entry({"admin","owrtmusicbox"}, template("owrtmusicbox"), _("Owrt-MusicBox"), 90).leaf=true
end
LUCI_CTRL
    cat > /usr/lib/lua/luci/view/owrtmusicbox.htm << 'LUCI_VIEW'
<%+header%>
<div class="cbi-map">
    <iframe id="owrtmb-p" style="width:100%;min-height:90vh;border:none;"></iframe>
</div>
<script>document.getElementById("owrtmb-p").src=location.protocol+"//"+location.hostname+":2030";</script>
<%+footer%>
LUCI_VIEW
    rm -rf /tmp/luci-* 2>/dev/null || true; log_ok "LuCI tab added"
fi

# ============================================
# VERIFIKASI
# ============================================
echo ""; echo -e "${YELLOW}---[✓] Verification ---${NC}"
sleep 2

SERVICE_ACTIVE=false
if command -v curl &>/dev/null; then curl -s http://localhost:$OWRTMB_PORT/status >/dev/null 2>&1 && SERVICE_ACTIVE=true
elif command -v wget &>/dev/null; then wget -q -O- http://localhost:$OWRTMB_PORT/status >/dev/null 2>&1 && SERVICE_ACTIVE=true
fi

[ "$SERVICE_ACTIVE" = true ] && log_ok "Service RUNNING on port $OWRTMB_PORT" || log_warn "Service not verified. Try: curl http://localhost:$OWRTMB_PORT/status"

# ============================================
# SUMMARY
# ============================================
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}       ✅ INSTALLATION COMPLETE!${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
python3 -c "
try:
    import flask; print(f'  ✅ Flask {flask.__version__}')
except: print('  ❌ Flask')
try:
    import ytmusicapi; print(f'  ✅ YTMusicAPI {ytmusicapi.__version__}')
except: print('  ❌ YTMusicAPI')
" 2>/dev/null
command -v mpv >/dev/null && echo -e "  ✅ MPV" || echo -e "  ⚠️ MPV (via Docker)"
command -v ffmpeg >/dev/null && echo -e "  ✅ FFmpeg" || echo -e "  ❌ FFmpeg"
command -v yt-dlp >/dev/null && echo -e "  ✅ yt-dlp v$(yt-dlp --version 2>/dev/null)" || echo -e "  ❌ yt-dlp"
echo ""

LOCAL_IP=$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v 127.0.0.1 | head -1)
[ -z "$LOCAL_IP" ] && LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LOCAL_IP" ] && LOCAL_IP="<ip-anda>"

echo -e "${YELLOW}Access:${NC}"
echo -e "  ${GREEN}🌐${NC} http://localhost:$OWRTMB_PORT"
echo -e "  ${GREEN}📡${NC} http://$LOCAL_IP:$OWRTMB_PORT"
if [ "$IS_OPENWRT" = true ] && [ -f /usr/lib/lua/luci/view/owrtmusicbox.htm ]; then
    echo -e "  ${GREEN}📋${NC} LuCI tab"
fi
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}  🎵 Owrt-MusicBox ready! 🎵${NC}"
echo -e "${CYAN}============================================${NC}"