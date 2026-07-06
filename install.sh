#!/bin/bash
# ============================================
# OpenWrt-Music-Box All-in-One Installer
# ============================================
# ONE COMMAND: chmod +x install.sh && ./install.sh
# Semuanya otomatis: install → start → LuCI setup
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
OWMB_PORT=2030

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}    OpenWrt-Music-Box - All-in-One Installer${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# ============================================
# BUAT run.sh DI AWAL (biar selalu ada)
# ============================================
cat > "$SCRIPT_DIR/run.sh" << 'RUNEOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f "$SCRIPT_DIR/venv/bin/activate" ]; then
    source "$SCRIPT_DIR/venv/bin/activate"
fi
python3 app.py
RUNEOF
chmod +x "$SCRIPT_DIR/run.sh"
log_ok "Created run.sh"

# ============================================
# STEP 1: Detect OS
# ============================================
echo ""
echo -e "${YELLOW}---[1/6] System Update & Package Manager ---${NC}"

detect_os() {
    if command -v apt &>/dev/null; then
        PKG_MANAGER="apt"
        PKG_INSTALL="sudo apt install -y"
        PKG_UPDATE="sudo apt update"
        IS_OPENWRT=false
    elif command -v opkg &>/dev/null; then
        PKG_MANAGER="opkg"
        PKG_INSTALL="opkg install"
        PKG_UPDATE="opkg update"
        IS_OPENWRT=true
    elif command -v apk &>/dev/null; then
        PKG_MANAGER="apk"
        PKG_INSTALL="sudo apk add"
        PKG_UPDATE="sudo apk update"
        IS_OPENWRT=false
    else
        log_error "No supported package manager found."
        PKG_MANAGER="unknown"
        IS_OPENWRT=false
    fi
    log_ok "Detected: $PKG_MANAGER"
}
detect_os

log_info "Updating package lists..."
$PKG_UPDATE 2>&1 | tail -1 || log_warn "Update failed, continuing..."

# ============================================
# STEP 2: System Dependencies
# ============================================
echo ""
echo -e "${YELLOW}---[2/6] System Dependencies ---${NC}"

install_pkg() {
    local pkg="$1"
    local check="${2:-which $pkg}"
    if eval "$check" &>/dev/null; then
        log_ok "$pkg already installed"
    else
        log_info "Installing $pkg..."
        $PKG_INSTALL "$pkg" 2>&1 | tail -1 || true
        if eval "$check" &>/dev/null; then
            log_ok "$pkg installed"
        else
            log_warn "Failed to install $pkg"
            ALL_OK=false
        fi
    fi
}

# Wrapper without sudo (OpenWrt has no sudo)
run_cmd() {
    if command -v sudo &>/dev/null; then sudo "$@"; else "$@"; fi
}

if [ "$PKG_MANAGER" = "apt" ]; then
    for p in python3 python3-pip python3-venv mpv ffmpeg bluez bluez-alsa-utils alsa-utils psmisc curl git socat; do
        install_pkg "$p" "which $p 2>/dev/null || dpkg -l $p 2>/dev/null | grep -q ^ii"
    done
elif [ "$PKG_MANAGER" = "opkg" ]; then
    for p in python3 python3-pip ffmpeg bluez-daemon kmod-usb-audio alsa-utils curl git socat; do
        install_pkg "$p" "opkg list-installed 2>/dev/null | grep -q $p"
    done
    # Cek mpv — biasanya tidak tersedia di OpenWrt
    HAS_MPV=false
    if opkg list 2>/dev/null | grep -q "^mpv"; then
        install_pkg "mpv" "opkg list-installed 2>/dev/null | grep -q mpv"
        HAS_MPV=true
    else
        log_warn "mpv not available in OpenWrt repo. Will use Docker for audio."
        # Cek & install Docker
        install_pkg "dockerd" "opkg list-installed 2>/dev/null | grep -q dockerd"
        install_pkg "docker-compose" "opkg list-installed 2>/dev/null | grep -q docker-compose"
        # Pastikan docker berjalan
        if ! /etc/init.d/dockerd running 2>/dev/null; then
            /etc/init.d/dockerd start 2>/dev/null || true
            log_info "Waiting for dockerd to start..."
            sleep 2
        fi
    fi
elif [ "$PKG_MANAGER" = "apk" ]; then
    HAS_MPV=true
    for p in python3 py3-pip mpv ffmpeg bluez alsa-utils curl git socat; do
        install_pkg "$p"
    done
fi

# pip3 check
if ! command -v pip3 &>/dev/null && command -v python3 &>/dev/null; then
    log_info "Installing pip3..."
    [ "$PKG_MANAGER" = "apt" ] && sudo apt install -y python3-pip 2>&1 | tail -1 || true
    [ "$PKG_MANAGER" = "opkg" ] && opkg install python3-pip 2>&1 | tail -1 || true
fi

# ============================================
# STEP 3: Python Virtual Environment
# ============================================
echo ""
echo -e "${YELLOW}---[3/6] Python Virtual Environment ---${NC}"

USE_VENV=true
if ! python3 -c "import venv" 2>/dev/null; then
    log_warn "python3-venv not available"
    if [ "$PKG_MANAGER" = "apt" ]; then
        sudo apt install -y python3-venv 2>&1 | tail -1 || true
        python3 -c "import venv" 2>/dev/null || USE_VENV=false
    elif [ "$PKG_MANAGER" = "opkg" ]; then
        opkg install python3-venv 2>/dev/null || USE_VENV=false
    else
        USE_VENV=false
    fi
fi

if [ "$USE_VENV" = true ]; then
    [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/python3" ] && \
        log_ok "venv already exists" || \
        { python3 -m venv "$VENV_DIR" && log_ok "venv created"; }
    source "$VENV_DIR/bin/activate" 2>/dev/null || true
    PIP_CMD="pip"
    log_info "Upgrading pip..."
    pip install --upgrade pip 2>&1 | tail -1 || true
else
    log_info "Installing packages system-wide..."
    PIP_CMD="pip3"
    command -v pip3 &>/dev/null || PIP_CMD="python3 -m pip"
fi

# ============================================
# STEP 4: Python Dependencies
# ============================================
echo ""
echo -e "${YELLOW}---[4/6] Python Dependencies ---${NC}"

if [ -f "$REQUIREMENTS" ]; then
    log_info "Installing from requirements.txt..."
    $PIP_CMD install -r "$REQUIREMENTS" 2>&1 | tail -1 || log_warn "pip install had issues"
    log_info "Verifying packages..."
    python3 -c "
import importlib.metadata
for p in ['flask','requests','ytmusicapi','mutagen']:
    try:
        v = importlib.metadata.version(p)
        print(f'  ✅ {p}=={v}')
    except:
        print(f'  ❌ {p} NOT FOUND')
" 2>/dev/null
else
    log_warn "requirements.txt not found"
    $PIP_CMD install flask requests ytmusicapi mutagen 2>&1 | tail -1 || true
fi

# ============================================
# STEP 5: yt-dlp
# ============================================
echo ""
echo -e "${YELLOW}---[5/6] yt-dlp (YouTube Downloader) ---${NC}"

YTDLP_BIN="/usr/local/bin/yt-dlp"
if command -v yt-dlp &>/dev/null; then
    log_ok "yt-dlp already: v$(yt-dlp --version 2>/dev/null || echo '?')"
fi

if command -v curl &>/dev/null; then
    log_info "Downloading latest yt-dlp..."
    run_cmd curl -sL --connect-timeout 10 \
        https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o "$YTDLP_BIN" 2>&1 && \
    run_cmd chmod a+rx "$YTDLP_BIN" && \
    log_ok "yt-dlp installed: v$(yt-dlp --version 2>/dev/null || echo 'OK')" || \
    log_warn "yt-dlp download failed (check internet). Will use mpv built-in fallback."
elif command -v wget &>/dev/null; then
    run_cmd wget -q --timeout=10 \
        https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -O "$YTDLP_BIN" 2>&1 && \
    run_cmd chmod a+rx "$YTDLP_BIN" && \
    log_ok "yt-dlp installed" || \
    log_warn "yt-dlp download failed"
else
    log_warn "curl/wget not found, skipping yt-dlp"
fi

# ============================================
# STEP 6: Final Setup
# ============================================
echo ""
echo -e "${YELLOW}---[6/6] Final Setup & Verification ---${NC}"

log_info "Setting permissions..."
chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true
mkdir -p "$SCRIPT_DIR/data"

# FontAwesome
if [ ! -f "$SCRIPT_DIR/static/css/all.min.css" ]; then
    log_info "Downloading FontAwesome assets..."
    python3 "$SCRIPT_DIR/get_assets.py" 2>&1 | tail -1 || log_warn "Asset download skipped"
else
    log_ok "FontAwesome assets ready"
fi

# ============================================
# STEP 7: AUTO-START SERVICE (Otomatis!)
# ============================================
echo ""
echo -e "${YELLOW}---[7/7] Auto-Start Service ---${NC}"

SERVICE_STARTED=false

if [ "$IS_OPENWRT" = true ] && [ "$HAS_MPV" != true ]; then
    # OpenWrt tanpa mpv → pakai Docker
    log_info "OpenWrt detected without mpv. Starting Docker container..."
    
    # Setup DNS Docker (biar build tidak gagal)
    if [ ! -f /etc/docker/daemon.json ]; then
        mkdir -p /etc/docker
        cat > /etc/docker/daemon.json << 'DOCKERDNS'
{
  "dns": ["8.8.8.8", "1.1.1.1"],
  "iptables": false
}
DOCKERDNS
        /etc/init.d/dockerd restart 2>/dev/null || true
        sleep 2
        log_ok "Docker DNS configured"
    fi
    
    # Build & start container
    cd "$SCRIPT_DIR"
    
    log_info "Step 1/2: Building Docker image (this may take 5-15 minutes first time)..."
    echo ""
    OWMB_PORT=$OWMB_PORT docker-compose build 2>&1
    BUILD_EXIT=$?
    
    if [ $BUILD_EXIT -ne 0 ]; then
        log_warn "Docker build had issues. Trying alternative DNS method..."
        # Fallback: build with --network host if DNS failed
        docker build --network host -t openwrt-music-box . 2>&1
        BUILD_EXIT=$?
    fi
    
    if [ $BUILD_EXIT -eq 0 ]; then
        echo ""
        log_ok "Build successful! Starting container..."
        OWMB_PORT=$OWMB_PORT docker-compose up -d 2>&1
    else
        log_error "Docker build failed. Check Docker DNS configuration."
        log_info "Try manual: cd $SCRIPT_DIR && OWMB_PORT=$OWMB_PORT docker-compose up -d --build"
    fi
    
    # Tunggu container ready
    echo ""
    log_info "Waiting for container to be ready..."
    for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
        sleep 2
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "openwrt-music-box"; then
            log_ok "Docker container is running!"
            SERVICE_STARTED=true
            break
        fi
        if [ $((i % 3)) -eq 0 ]; then
            log_info "  Still building... ($((i*2))s elapsed)"
        fi
    done
    
elif [ "$PKG_MANAGER" != "unknown" ]; then
    # Debian/Alpine dengan mpv → start langsung
    log_info "Starting service in background..."
    cd "$SCRIPT_DIR"
    nohup ./run.sh > /tmp/openwrt-music-box.log 2>&1 &
    sleep 3
    SERVICE_STARTED=true
    log_ok "Service started in background (PID: $!)"
fi

# ============================================
# STEP 8: LuCI Integration (Otomatis untuk OpenWrt)
# ============================================
if [ "$IS_OPENWRT" = true ] && [ -d /usr/lib/lua/luci ]; then
    echo ""
    echo -e "${YELLOW}---[+] OpenWrt LuCI Integration ---${NC}"
    
    # Buat controller
    cat > /usr/lib/lua/luci/controller/openwrtmusicbox.lua << 'LUCI_CTRL'
module("luci.controller.openwrtmusicbox", package.seeall)
function index()
    entry({"admin", "openwrtmusicbox"}, template("openwrtmusicbox"), _("OpenWrt-Music-Box"), 90).leaf=true
end
LUCI_CTRL
    log_ok "Created LuCI controller"
    
    # Buat view
    cat > /usr/lib/lua/luci/view/openwrtmusicbox.htm << 'LUCI_VIEW'
<%+header%>
<div class="cbi-map">
    <iframe id="owmb-player" style="width: 100%; min-height: 90vh; border: none; border-radius: 2px;"></iframe>
</div>
<script type="text/javascript">
    document.getElementById("owmb-player").src = window.location.protocol + "//" + window.location.hostname + ":2030";
</script>
<%+footer%>
LUCI_VIEW
    log_ok "Created LuCI view"
    
    # Clear cache
    rm -rf /tmp/luci-* 2>/dev/null || true
    log_ok "LuCI cache cleared"
    log_ok "OpenWrt-Music-Box akan muncul di menu LuCI setelah refresh!"
fi

# ============================================
# VERIFIKASI SERVICE
# ============================================
echo ""
echo -e "${YELLOW}---[✓] Service Verification ---${NC}"

sleep 2
SERVICE_ACTIVE=false

# Cek via curl
if command -v curl &>/dev/null; then
    if curl -s http://localhost:$OWMB_PORT/status >/dev/null 2>&1; then
        SERVICE_ACTIVE=true
    fi
elif command -v wget &>/dev/null; then
    if wget -q -O- http://localhost:$OWMB_PORT/status >/dev/null 2>&1; then
        SERVICE_ACTIVE=true
    fi
fi

if [ "$SERVICE_ACTIVE" = true ]; then
    log_ok "Service is RUNNING on port $OWMB_PORT"
    
    # Coba dapatkan info
    if command -v curl &>/dev/null; then
        STATUS_JSON=$(curl -s http://localhost:$OWMB_PORT/status 2>/dev/null)
        if [ -n "$STATUS_JSON" ]; then
            VERSION_INFO=$(echo "$STATUS_JSON" | grep -o '"title":"[^"]*"' | head -1)
            log_ok "Player status: $VERSION_INFO"
        fi
    fi
else
    if [ "$SERVICE_STARTED" = true ]; then
        log_warn "Service may need a moment. Check with: curl http://localhost:$OWMB_PORT/status"
        if [ "$IS_OPENWRT" = true ]; then
            log_info "For Docker logs: docker logs -f openwrt-music-box"
        else
            log_info "For logs: cat /tmp/openwrt-music-box.log"
        fi
    fi
fi

# ============================================
# SUMMARY
# ============================================
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}       ✅ INSTALLATION COMPLETE!${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "${YELLOW}Components:${NC}"
python3 -c "import flask; print('  ✅ Flask', flask.__version__)" 2>/dev/null || echo "  ❌ Flask"
python3 -c "import mutagen; print('  ✅ Mutagen', mutagen.version_string)" 2>/dev/null || echo "  ❌ Mutagen"
python3 -c "import ytmusicapi; print('  ✅ YTMusicAPI', ytmusicapi.__version__)" 2>/dev/null || echo "  ❌ YTMusicAPI"
command -v mpv >/dev/null && echo -e "  ✅ MPV" || echo -e "  ⚠️ MPV (will use Docker)"
command -v ffmpeg >/dev/null && echo -e "  ✅ FFmpeg" || echo -e "  ❌ FFmpeg"
command -v socat >/dev/null && echo -e "  ✅ socat" || echo -e "  ❌ socat"
command -v yt-dlp >/dev/null && echo -e "  ✅ yt-dlp ($(yt-dlp --version 2>/dev/null))" || echo -e "  ⚠️ yt-dlp (will use mpv fallback)"
echo ""

if [ "$SERVICE_ACTIVE" = true ]; then
    echo -e "  ${GREEN}✅ Service is RUNNING on port $OWMB_PORT${NC}"
else
    echo -e "  ${YELLOW}⚠️ Service status: not verified yet${NC}"
fi
echo ""

# Tampilkan IP address
LOCAL_IP=$(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v 127.0.0.1 | head -1)
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$LOCAL_IP" ]; then
    LOCAL_IP="<ip-anda>"
fi

echo -e "${YELLOW}Access:${NC}"
echo -e "  ${GREEN}🌐 Local:${NC}       http://localhost:$OWMB_PORT"
echo -e "  ${GREEN}📡 Network:${NC}     http://$LOCAL_IP:$OWMB_PORT"
if [ "$IS_OPENWRT" = true ] && [ -f /usr/lib/lua/luci/view/openwrtmusicbox.htm ]; then
    echo -e "  ${GREEN}📋 LuCI:${NC}      Login ke panel LuCI → tab OpenWrt-Music-Box"
fi
echo ""

# Command untuk akses cepat
echo -e "${YELLOW}Quick Commands:${NC}"
echo -e "  ./run.sh           # Start manually"
echo -e "  tail -f $LOG_FILE  # View logs" 2>/dev/null
if [ "$IS_OPENWRT" = true ] && [ "$HAS_MPV" != true ]; then
    echo -e "  docker logs -f openwrt-music-box  # Docker logs"
    echo -e "  docker-compose down               # Stop service"
    echo -e "  docker-compose up -d              # Start service"
fi
echo ""

if [ "$ALL_OK" = false ]; then
    echo -e "${YELLOW}⚠️  Some components had warnings (non-critical).${NC}"
fi
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}  🎵 OpenWrt-Music-Box is ready to rock! 🎵${NC}"
echo -e "${CYAN}============================================${NC}"