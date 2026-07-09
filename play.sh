#!/bin/bash

export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
export LC_ALL=C.UTF-8

SOCKET="/tmp/mpv_socket"
MODE_FILE="/root/output_mode"
BP_FILE="/root/bp_mode"
LOG_FILE="/root/mpv_error.log"
VOL_FILE="/root/owmb_last_volume"
INPUT_LINK="$1"
START_TIME="${2:-0}"

TARGET_VOL=30

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

killall -9 mpv > /dev/null 2>&1 || true
rm -f "$SOCKET"
sleep 0.5

MPV_BIN=$(which mpv)
if [ -z "$MPV_BIN" ]; then MPV_BIN="/usr/bin/mpv"; fi

AUDIO_DEVICE="alsa/plughw:0,0"
if [ -f "$MODE_FILE" ]; then
    READ_MODE=$(cat "$MODE_FILE")
    if [[ "$READ_MODE" != "" ]]; then
        AUDIO_DEVICE="$READ_MODE"
    fi
    if [[ "$READ_MODE" == *"plughw"* ]]; then
        if [[ "$READ_MODE" == *"hdmi"* || "$READ_MODE" == *"2,0"* ]]; then
             AUDIO_DEVICE="alsa/plughw:2,0"
        else
             AUDIO_DEVICE="alsa/plughw:0,0"
        fi
    fi
fi

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

if [ -f "$INPUT_LINK" ]; then
    CACHE_OPTS="--cache=yes --demuxer-max-bytes=5M"
    YTDL_OPTS=""
else
    CACHE_OPTS="--cache=yes --demuxer-max-bytes=20M --demuxer-max-back-bytes=10M"
    YTDL_OPTS="--ytdl-format=bestaudio/best --ytdl-raw-options=ignore-errors=,no-check-certificate="
fi

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
    --msg-level=all=error \
    $CACHE_OPTS \
    $YTDL_OPTS \
    $EXTRA_ARGS \
    >> "$LOG_FILE" 2>&1 &
disown