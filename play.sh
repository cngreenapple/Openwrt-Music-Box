#!/bin/bash

export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:/app/bin
export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOCKET="/tmp/mpv_socket"
MODE_FILE="/root/output_mode"
BP_FILE="/root/bp_mode"
LOG_FILE="/root/mpv_error.log"
VOL_FILE="/root/owmb_last_volume"
INPUT_LINK="$1"
START_TIME="${2:-0}"

TARGET_VOL=30

# Ambil volume terakhir
if [ -S "$SOCKET" ]; then
    RAW_VOL=$(echo '{ "command": ["get_property", "volume"] }' | socat - "$SOCKET" 2>/dev/null)
    PARSED_VOL=$(echo "$RAW_VOL" | sed -n 's/.*"data": *\([0-9.]*\).*/\1/p')
    if [ -n "$PARSED_VOL" ]; then
        TARGET_VOL=$PARSED_VOL
        echo "$TARGET_VOL" > "$VOL_FILE"
    fi
fi
if [ -z "$PARSED_VOL" ] && [ -f "$VOL_FILE" ]; then
    TARGET_VOL=$(cat "$VOL_FILE")
fi

# Soft kill mpv sebelumnya
if [ -S "$SOCKET" ]; then
    echo '{ "command": ["quit"] }' | socat - "$SOCKET" 2>/dev/null || true
    sleep 0.3
fi
if pgrep mpv > /dev/null 2>&1; then
    killall mpv 2>/dev/null || true
    sleep 0.3
fi
rm -f "$SOCKET"
sleep 0.5

MPV_BIN=$(which mpv)
if [ -z "$MPV_BIN" ]; then MPV_BIN="/usr/bin/mpv"; fi

# === AUDIO DEVICE DETECTION ===
# Prioritas: MODE_FILE > default ALSA
AUDIO_DEVICE=""
if [ -f "$MODE_FILE" ]; then
    READ_MODE=$(cat "$MODE_FILE" | tr -d '\n')
    if [ -n "$READ_MODE" ]; then
        if [[ "$READ_MODE" == *"bluealsa"* ]]; then
            AUDIO_DEVICE="$READ_MODE"
        elif [[ "$READ_MODE" == *"plughw"* ]]; then
            AUDIO_DEVICE="$READ_MODE"
        else
            AUDIO_DEVICE="$READ_MODE"
        fi
    fi
fi

# Fallback: deteksi device ALSA yang tersedia
if [ -z "$AUDIO_DEVICE" ]; then
    # Coba beberapa device
    for dev in "alsa/plughw:1,2" "alsa/plughw:0,0" "alsa/plughw:1,0" "alsa/default" "alsa/plughw:2,0"; do
        if mpv --audio-device=help 2>/dev/null | grep -q "${dev#alsa/}"; then
            AUDIO_DEVICE="$dev"
            break
        fi
    done
fi

# Final fallback
if [ -z "$AUDIO_DEVICE" ]; then
    AUDIO_DEVICE="alsa/plughw:0,0"
fi

# === EXTRA ARGS ===
EXTRA_ARGS=""
if [[ "$AUDIO_DEVICE" == *"bluealsa"* ]]; then
    EXTRA_ARGS="--ao=alsa --audio-format=s16 --audio-samplerate=44100 --audio-buffer=0.5"
else
    IS_BP="0"
    if [ -f "$BP_FILE" ]; then IS_BP=$(cat "$BP_FILE" | tr -d '[:space:]'); fi
    if [ "$IS_BP" == "1" ]; then
        EXTRA_ARGS="--ao=alsa --no-audio-resample --audio-buffer=0.2"
    else
        EXTRA_ARGS="--ao=alsa"
    fi
fi

# === YT-DLP ===
# Cari yt-dlp di berbagai lokasi
YT_DLP_BIN=""
for p in "$(which yt-dlp 2>/dev/null)" "/usr/local/bin/yt-dlp" "$SCRIPT_DIR/bin/yt-dlp" "$(python3 -c 'import yt_dlp; print(yt_dlp.__file__)' 2>/dev/null)"; do
    if [ -n "$p" ] && [ -f "$p" ]; then
        YT_DLP_BIN="$p"
        break
    fi
done

if [ -f "$INPUT_LINK" ]; then
    CACHE_OPTS="--cache=yes --demuxer-max-bytes=5M"
    YTDL_OPTS=""
else
    CACHE_OPTS="--cache=yes --demuxer-max-bytes=20M --demuxer-max-back-bytes=10M"
    if [ -n "$YT_DLP_BIN" ]; then
        YTDL_OPTS="--script-opts=ytdl_hooks-ytdl_path=$YT_DLP_BIN --ytdl-format=bestaudio/best --ytdl-raw-options=ignore-errors=,no-check-certificate="
    else
        YTDL_OPTS="--ytdl-format=bestaudio/best --ytdl-raw-options=ignore-errors=,no-check-certificate="
    fi
fi

# Simpan AUDIO_DEVICE yang terdeteksi ke file untuk referensi
echo "$AUDIO_DEVICE" > "$MODE_FILE" 2>/dev/null || true

nohup "$MPV_BIN" "$INPUT_LINK" \
    --start="$START_TIME" \
    --input-ipc-server="$SOCKET" \
    --no-video \
    --force-window=no \
    --no-terminal \
    --volume="$TARGET_VOL" \
    --audio-device="$AUDIO_DEVICE" \
    --keep-open=yes \
    --idle=yes \
    --gapless=yes \
    --msg-level=all=error \
    $CACHE_OPTS \
    $YTDL_OPTS \
    $EXTRA_ARGS \
    >> "$LOG_FILE" 2>&1 &
disown