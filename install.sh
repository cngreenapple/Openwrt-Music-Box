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

# Auto-update from GitHub (safe to run repeatedly)
if command -v git &>/dev/null && [ -d "$SCRIPT_DIR/.git" ]; then
    log_info "Checking for updates from GitHub..."
    git fetch origin 2>/dev/null
    BEHIND=$(git rev-list HEAD..origin/main --count 2>/dev/null)
    if [ "$BEHIND" -gt 0 ]; then
        log_warn "Found $BEHIND new commit(s). Updating..."
        git pull origin main 2>&1
        log_ok "Updated! Restarting installer with new code..."
        exec "$0" "$@"
    else
        log_ok "Already up to date."
    fi
fi

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
# STEP 5: yt-dlp (Python Library + Binary)
# ============================================
echo ""; echo -e "${YELLOW}---[5/6] yt-dlp (YouTube) ---${NC}"

# 1. Install Python library yt-dlp (PALING PENTING untuk play.sh)
log_info "Installing yt-dlp Python library..."
$PIP_CMD install --upgrade yt-dlp 2>&1 | tail -1 || true

# 2. Verifikasi Python library
if python3 -c "import yt_dlp" 2>/dev/null; then
    log_ok "yt-dlp Python library ready"
else
    log_warn "yt-dlp Python library failed to install"
fi

# 3. Coba download binary juga sebagai fallback
YTDLP_BIN="/usr/local/bin/yt-dlp"
if ! command -v yt-dlp &>/dev/null; then
    log_info "Mencoba download yt-dlp binary..."
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
    for url in "https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt-dlp/yt-dlp" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "https://hub.fastgit.xyz/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"; do
        if download_ytdlp "$url" "$YTDLP_BIN"; then
            chmod a+rx "$YTDLP_BIN" 2>/dev/null
            if command -v yt-dlp &>/dev/null; then log_ok "yt-dlp binary installed"; break; fi
        fi
    done
fi

# 4. Simpan binary di project/bin/
if command -v yt-dlp &>/dev/null && [ ! -f "$SCRIPT_DIR/bin/yt-dlp" ]; then
    mkdir -p "$SCRIPT_DIR/bin"
    cp "$(which yt-dlp)" "$SCRIPT_DIR/bin/yt-dlp" 2>/dev/null || true
    log_ok "yt-dlp copied to project/bin/"
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
# STEP 7: AUTO-START (Background Service)
# ============================================
echo ""; echo -e "${YELLOW}---[7/7] Auto-Start (Background Service) ---${NC}"

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
elif [ "$IS_OPENWRT" = true ] && [ -f /sbin/procd ]; then
    # Register OpenWrt init script (procd-based background service)
    cp "$SCRIPT_DIR/owrtmusicbox.init" /etc/init.d/owrtmusicbox
    chmod +x /etc/init.d/owrtmusicbox
    /etc/init.d/owrtmusicbox enable
    log_info "Starting Owrt-MusicBox as background service..."
    /etc/init.d/owrtmusicbox start
    sleep 3
    if /etc/init.d/owrtmusicbox running; then
        log_ok "Service registered & RUNNING (auto-start on boot)"
        SERVICE_STARTED=true
    else
        log_warn "Service registered but not responding yet"
    fi
else
    log_info "Starting service..."; cd "$SCRIPT_DIR"
    nohup ./run.sh > /tmp/owrt-musicbox.log 2>&1 &
    sleep 2; SERVICE_STARTED=true; log_ok "Service started (PID: $!)"
    log_warn "Not a persistent service. Use install.sh on OpenWrt for auto-start."
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
# VERIFIKASI (dengan retry)
# ============================================
echo ""; echo -e "${YELLOW}---[✓] Verification ---${NC}"

SERVICE_ACTIVE=false
for i in 1 2 3 4 5 6 7 8; do
    sleep 2
    if command -v curl &>/dev/null; then
        curl -s http://localhost:$OWRTMB_PORT/status >/dev/null 2>&1 && { SERVICE_ACTIVE=true; break; }
    elif command -v wget &>/dev/null; then
        wget -q -O- http://localhost:$OWRTMB_PORT/status >/dev/null 2>&1 && { SERVICE_ACTIVE=true; break; }
    fi
    log_info "Waiting for service... ($i/8)"
done

# If still not active, check container logs
if [ "$SERVICE_ACTIVE" = true ]; then
    log_ok "Service RUNNING on port $OWRTMB_PORT"
else
    log_warn "Service not responding. Checking container logs..."
    docker logs --tail 20 owrt-musicbox 2>/dev/null || true
    log_info "Try: curl http://localhost:$OWRTMB_PORT/status"
    log_info "Or: docker logs -f owrt-musicbox"
fi

# ============================================
# SUMMARY
# ============================================
echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}       ✅ INSTALLATION COMPLETE!${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
python3 -c "
import sys
try:
    import flask; print(f'  ✅ Flask {flask.__version__}')
except: print('  ❌ Flask')
try:
    import importlib.metadata as m
    v = m.version('ytmusicapi')
    print(f'  ✅ YTMusicAPI {v}')
except:
    try:
        import ytmusicapi; print(f'  ✅ YTMusicAPI (terinstall)')
    except: print('  ❌ YTMusicAPI')
" 2>/dev/null
command -v mpv >/dev/null && echo -e "  ✅ MPV" || echo -e "  ⚠️ MPV (via Docker)"
command -v ffmpeg >/dev/null && echo -e "  ✅ FFmpeg" || echo -e "  ❌ FFmpeg"
command -v yt-dlp >/dev/null && echo -e "  ✅ yt-dlp v$(yt-dlp --version 2>/dev/null)" || echo -e "  ❌ yt-dlp"
echo ""

LOCAL_IP=$(ip -4 addr show 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 | grep -v '^127\.' | head -1)
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