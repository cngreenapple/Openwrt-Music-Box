from flask import Flask, render_template, request, jsonify, send_file, Response, stream_with_context
import uuid
import subprocess
import json
import os
import threading
import time
import socket
import re
import hashlib
import random
import requests
from threading import Lock
from ytmusicapi import YTMusic

try:
    from library import lib_mgr
except ImportError:
    lib_mgr = None

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MPV_SOCKET = "/tmp/mpv_socket"
PLAYLIST_FILE = os.path.join(BASE_DIR, "playlist.json")
COVER_DIR = os.path.join(BASE_DIR, "static", "covers")
PLAY_SCRIPT = os.path.join(BASE_DIR, "play.sh")
TOGGLE_SCRIPT = os.path.join(BASE_DIR, "toggle_output.sh")
MODE_FILE = "/root/output_mode"
DEFAULT_PATH_FILE = os.path.join(BASE_DIR, "default_path.txt")
BP_MODE_FILE = "/root/bp_mode"

AUDIO_EXTS = ('.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus', '.wma', '.aac', '.dsf', '.dff')
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

state_lock = Lock()
yt_music = YTMusic()
needs_restore = False

st4_state = {
    "title": "Ready", 
    "artist": "Waiting...", 
    "album": "",
    "genre": "", 
    "year": "", 
    "tech_info": "",
    "current_time": 0, 
    "total_time": 0, 
    "status": "stopped",
    "volume": 30, 
    "status_output": "jack", 
    "active_preset": "Normal",
    "thumb": "",
    "queue": [],
    "current_index": -1,
    "sleep_target": 0,
    "current_eq_cmd": "",
    "connected_bt_mac": "",
    "connected_bt_name": "",
    "last_play_time": 0,
    "error_count": 0,
    "manual_stop": False
}

af_state = {"eq": "", "balance": "", "crossfeed": ""}

EQ_PRESETS = {
    "Normal": {"f1":0,"f2":0,"f3":0,"f4":0,"f5":0,"f6":0,"f7":0,"f8":0,"f9":0,"f10":0},
    "Bass":   {"f1":7,"f2":6,"f3":5,"f4":3,"f5":0,"f6":0,"f7":0,"f8":-1,"f9":-2,"f10":-3},
    "Rock":   {"f1":5,"f2":3,"f3":1,"f4":-1,"f5":-2,"f6":0,"f7":2,"f8":4,"f9":5,"f10":5},
    "Pop":    {"f1":-1,"f2":1,"f3":3,"f4":4,"f5":4,"f6":2,"f7":0,"f8":1,"f9":2,"f10":2},
    "Jazz":   {"f1":2,"f2":2,"f3":4,"f4":2,"f5":2,"f6":4,"f7":2,"f8":2,"f9":3,"f10":3},
    "Vocal":  {"f1":-3,"f2":-3,"f3":-2,"f4":0,"f5":4,"f6":6,"f7":5,"f8":3,"f9":1,"f10":-1},
    "Dance":  {"f1":8,"f2":7,"f3":4,"f4":0,"f5":0,"f6":2,"f7":4,"f8":5,"f9":6,"f10":5},
    "Acoust": {"f1":1,"f2":2,"f3":2,"f4":3,"f5":4,"f6":4,"f7":3,"f8":2,"f9":3,"f10":2},
    "Party":  {"f1":7,"f2":6,"f3":4,"f4":1,"f5":2,"f6":4,"f7":5,"f8":5,"f9":6,"f10":5},
    "Soft":   {"f1":0,"f2":-1,"f3":-1,"f4":1,"f5":2,"f6":1,"f7":0,"f8":-1,"f9":-2,"f10":-4},
    "Metal":  {"f1":6,"f2":5,"f3":0,"f4":-2,"f5":-3,"f6":0,"f7":3,"f8":6,"f9":7,"f10":7},
    "Classic":{"f1":4,"f2":3,"f3":2,"f4":2,"f5":-1,"f6":-1,"f7":0,"f8":2,"f9":3,"f10":4},
    "RnB":    {"f1":6,"f2":5,"f3":3,"f4":0,"f5":-1,"f6":2,"f7":3,"f8":2,"f9":3,"f10":4},
    "Live":   {"f1":-2,"f2":0,"f3":2,"f4":3,"f5":4,"f6":4,"f7":4,"f8":3,"f9":2,"f10":1},
    "Techno": {"f1":8,"f2":7,"f3":0,"f4":-2,"f5":-2,"f6":0,"f7":2,"f8":4,"f9":6,"f10":6},
    "KZEDCPro": {"f1":6,"f2":5,"f3":3,"f4":1,"f5":0,"f6":0,"f7":-1,"f8":-1,"f9":0,"f10":0}
}

def is_bp_active():
    if os.path.exists(BP_MODE_FILE):
        try:
            with open(BP_MODE_FILE, 'r') as f: return f.read().strip() == "1"
        except: pass
    return False

def update_mpv_filters():
    if is_bp_active():
        mpv_send(["set_property", "af", ""]) 
        mpv_send(["set_property", "volume", 100])
        with state_lock: st4_state["volume"] = 100
        return 
    
    filters = []
    if af_state["balance"]: filters.append(af_state["balance"])
    if af_state["eq"]: filters.append(af_state["eq"])
    if af_state["crossfeed"]: filters.append(af_state["crossfeed"])
    
    cmd_str = ",".join(filters) if filters else ""
    mpv_send(["set_property", "af", cmd_str])

def mpv_send(cmd):
    if not os.path.exists(MPV_SOCKET): return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.2)
        s.connect(MPV_SOCKET)
        s.send((json.dumps({"command": cmd}) + "\n").encode())
        res = s.recv(8192).decode()
        s.close()
        return json.loads(res).get("data")
    except: return None

def get_yt_thumb(url):
    match = re.search(r"([a-zA-Z0-9_-]{11})", url or "")
    if match: return f"https://img.youtube.com/vi/{match.group(1)}/0.jpg"
    return ""

def extract_local_cover(filepath):
    if not filepath or not os.path.exists(filepath): return ""
    try:
        hash_name = hashlib.md5(filepath.encode('utf-8')).hexdigest()
        cover_filename = f"{hash_name}.jpg"
        save_path = os.path.join(COVER_DIR, cover_filename)
        if os.path.exists(save_path): return f"/static/covers/{cover_filename}"
        if os.path.getsize(filepath) < 102400: return ""
        
        cmd = ["ffmpeg", "-i", filepath, "-an", "-vcodec", "mjpeg", "-q:v", "2", "-frames:v", "1", "-y", save_path]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if os.path.exists(save_path): return f"/static/covers/{cover_filename}"
    except: pass
    return ""

def detect_alsa_device():
    try:
        output = subprocess.check_output("aplay -l 2>/dev/null | head -20", shell=True).decode()
        for line in output.split('\n'):
            m = re.search(r'card\s+(\d+).*device\s+(\d+)', line)
            if m:
                card = m.group(1); dev = m.group(2)
                return f"alsa/plughw:{card},{dev}"
    except: pass
    try:
        out = subprocess.check_output("aplay -l 2>/dev/null | grep 'card 0'", shell=True).decode()
        if out: return "alsa/plughw:0,0"
    except: pass
    return "alsa/default"

def get_audio_device_string(mode):
    if mode == "jack":
        dev = detect_alsa_device()
        with open(MODE_FILE, "w") as f: f.write(dev)
        return dev
    elif mode == "hdmi":
        try:
            output = subprocess.check_output("aplay -l 2>/dev/null | grep -i hdmi | head -1", shell=True).decode()
            m = re.search(r'card\s+(\d+).*device\s+(\d+)', output)
            if m: return f"alsa/plughw:{m.group(1)},{m.group(2)}"
        except: pass
        return "alsa/plughw:2,0"
    elif mode == "bluetooth":
        mac, name = get_connected_bt()
        if mac: return f"alsa/bluealsa:DEV={mac},PROFILE=a2dp"
        return f"alsa/bluealsa:DEV={st4_state.get('connected_bt_mac','')},PROFILE=a2dp"
    return detect_alsa_device()

def trigger_play(url):
    global needs_restore
    if os.path.exists(PLAY_SCRIPT):
        with state_lock: 
            st4_state["last_play_time"] = time.time()
            if "http" in url: st4_state["thumb"] = get_yt_thumb(url)
            else: st4_state["thumb"] = ""
            st4_state["status"] = "loading"
            st4_state["manual_stop"] = False 
        
        needs_restore = True
        subprocess.Popen(["/bin/bash", PLAY_SCRIPT, url])

def play_next_in_queue():
    with state_lock:
        if not st4_state["queue"]: return
        time_diff = time.time() - st4_state.get("last_play_time", 0)
        
        if time_diff < 2.0: st4_state["error_count"] += 1
        else: st4_state["error_count"] = 0
            
        if st4_state["error_count"] > 5:
            st4_state["status"] = "stopped"
            st4_state["error_count"] = 0
            return

        next_idx = st4_state["current_index"] + 1
        if next_idx < len(st4_state["queue"]):
            st4_state["current_index"] = next_idx
            next_song = st4_state["queue"][next_idx]
            threading.Thread(target=trigger_play, args=(next_song['link'],)).start()
        else:
            st4_state["status"] = "stopped"

def find_key_insensitive(data, search_keys):
    if not data or not isinstance(data, dict): return ""
    for k in search_keys:
        for data_k, data_v in data.items():
            if data_k.lower() == k.lower(): return data_v
    return ""

def get_connected_bt():
    try:
        output = subprocess.check_output("bluetoothctl info", shell=True).decode()
        if "Connected: yes" in output:
            mac_match = re.search(r"Device\s+([0-9A-F:]{17})", output)
            name_match = re.search(r"Name:\s+(.*)", output)
            if mac_match:
                return mac_match.group(1), (name_match.group(1) if name_match else "Unknown")
    except: pass
    return None, None

def metadata_worker():
    global needs_restore
    last_path = ""
    idle_counter = 0
    
    if not os.path.exists(COVER_DIR): os.makedirs(COVER_DIR, exist_ok=True)
    
    while True:
        try:
            bt_mac, bt_name = get_connected_bt()
            with state_lock:
                st4_state["connected_bt_mac"] = bt_mac or ""
                st4_state["connected_bt_name"] = bt_name or ""

            with state_lock:
                target = st4_state["sleep_target"]
                if target > 0 and time.time() >= target:
                    st4_state["sleep_target"] = 0
                    st4_state["queue"] = []
                    st4_state["current_index"] = -1
                    threading.Thread(target=mpv_send, args=(["stop"],)).start()
            
            mpv_ready = False
            try:
                if mpv_send(["get_property", "idle-active"]) is not None:
                    mpv_ready = True
            except: pass

            if mpv_ready:
                idle_counter = 0 
                path = mpv_send(["get_property", "path"])
                
                if path and (path != last_path or needs_restore):
                    last_path = path
                    needs_restore = False
                    time.sleep(0.5)
                    with state_lock: saved_vol = st4_state["volume"]
                    mpv_send(["set_property", "volume", saved_vol])
                    update_mpv_filters()

                is_eof = mpv_send(["get_property", "eof-reached"])
                is_idle = mpv_send(["get_property", "idle-active"])
                
                if st4_state.get("manual_stop", False):
                    if is_idle:
                        with state_lock: st4_state["manual_stop"] = False
                elif is_eof is True or (is_idle is True and st4_state["status"] == "playing"):
                    play_next_in_queue()
                    time.sleep(1)
                    continue

                final_thumb = ""
                queue_title = "Unknown Title"
                with state_lock:
                    if st4_state["queue"] and st4_state["current_index"] < len(st4_state["queue"]):
                        queue_item = st4_state["queue"][st4_state["current_index"]]
                        final_thumb = queue_item.get('thumb', '')
                        queue_title = queue_item.get('title', 'Unknown Title')
                
                if not final_thumb:
                    if path and "http" in path: 
                        if "googlevideo" not in path: final_thumb = get_yt_thumb(path)
                    else:
                        loc = extract_local_cover(path)
                        if loc: final_thumb = loc
                with state_lock: st4_state["thumb"] = final_thumb

                meta_all = mpv_send(["get_property", "metadata"]) or {}
                mpv_title = mpv_send(["get_property", "media-title"])
                
                final_title = queue_title 
                if mpv_title:
                    is_junk = any(x in mpv_title.lower() for x in ["http", "www.", ".com", "webm&", "googlevideo", "?source"])
                    if not is_junk: final_title = mpv_title
                
                temp_artist = find_key_insensitive(meta_all, ["artist", "performer", "composer"])
                
                if not temp_artist or temp_artist.lower() == "unknown artist":
                    target_title = queue_title if " - " in queue_title else final_title
                    if " - " in target_title:
                        parts = target_title.split(" - ", 1)
                        temp_artist = parts[0].strip()
                        final_title = parts[1].strip()
                    else:
                        temp_artist = "Unknown Artist"
                
                temp_album = find_key_insensitive(meta_all, ["album"]) or ""
                temp_genre = find_key_insensitive(meta_all, ["genre"])
                temp_year = find_key_insensitive(meta_all, ["date", "year", "original_date"])
                
                is_paused = mpv_send(["get_property", "pause"])
                temp_status = "paused" if is_paused else "playing"

                tech_display = []
                raw_codec = mpv_send(["get_property", "audio-codec-name"])
                raw_fmt = mpv_send(["get_property", "audio-params/format"]) 
                raw_rate = mpv_send(["get_property", "audio-params/samplerate"]) 
                raw_br = mpv_send(["get_property", "audio-bitrate"])
                
                codec_str = raw_codec.upper() if raw_codec else "UNK"
                lossy_list = ['MP3', 'AAC', 'VORBIS', 'OPUS', 'WMA', 'WEBM', 'OGG', 'SBC']
                is_lossy = any(x in codec_str for x in lossy_list)
                
                bit_depth = ""
                if raw_fmt:
                    if 's16' in raw_fmt: bit_depth = "16bit"
                    elif 's24' in raw_fmt: bit_depth = "24bit"
                    elif 's32' in raw_fmt or 'float' in raw_fmt: bit_depth = "32bit"
                    elif 'u8' in raw_fmt: bit_depth = "8bit"
                    elif 'dsd' in raw_fmt: bit_depth = "1bit (DSD)"

                freq_str = ""
                sample_rate_val = 0
                if raw_rate:
                    try:
                        sample_rate_val = float(raw_rate)
                        freq_str = f"{sample_rate_val/1000:g}kHz"
                    except: pass

                bitrate_str = ""
                final_bitrate_val = 0
                if raw_br and int(raw_br) > 0:
                    final_bitrate_val = int(raw_br)
                else:
                    try:
                        f_size = mpv_send(["get_property", "file-size"])
                        f_dur = mpv_send(["get_property", "duration"])
                        if f_size and f_dur and float(f_dur) > 0:
                            final_bitrate_val = (int(f_size) * 8) / float(f_dur)
                    except: pass
                
                if final_bitrate_val > 0:
                    bitrate_str = f"{int(final_bitrate_val/1000)}kbps"

                quality_badge = ""
                if is_lossy:
                    quality_badge = "Lossy"
                else:
                    if (bit_depth in ["24bit", "32bit"]) or (sample_rate_val > 48000):
                        quality_badge = "Hi-Res"
                    else:
                        quality_badge = "Lossless"

                tech_display.append(codec_str)
                if bitrate_str: tech_display.append(bitrate_str)
                if freq_str: tech_display.append(freq_str)
                if not is_lossy and bit_depth: tech_display.append(bit_depth) 
                tech_display.append(quality_badge)

                temp_info = " • ".join(tech_display)
                
                with state_lock:
                    st4_state.update({
                        "title": final_title,
                        "artist": temp_artist, "album": temp_album,
                        "genre": temp_genre, "year": temp_year,
                        "status": temp_status,
                        "tech_info": temp_info,
                        "current_time": mpv_send(["get_property", "time-pos"]) or 0,
                        "total_time": mpv_send(["get_property", "duration"]) or 0
                    })
                    val_vol = mpv_send(["get_property", "volume"])
                    if val_vol is not None: st4_state["volume"] = val_vol
            else:
                idle_counter += 1
                if idle_counter == 5:
                    with state_lock: st4_state["status"] = "stopped"
                if idle_counter == 15 and st4_state["status"] != "stopped":
                    play_next_in_queue()
                    
        except Exception as e: pass
        time.sleep(1)

threading.Thread(target=metadata_worker, daemon=True).start()

# ========================
# ROUTES
# ========================

@app.route('/')
def index(): return render_template('index.html')

@app.route('/status')
def status():
    with state_lock:
        resp = st4_state.copy()
        target = resp.get("sleep_target", 0)
        if target > 0:
            remaining = int(target - time.time())
            if remaining > 0:
                resp["timer_display"] = f"{int(remaining/60)+1}m"
                resp["timer_active"] = True
            else:
                resp["timer_display"] = "OFF"
                resp["timer_active"] = False
        else:
            resp["timer_display"] = "OFF"
            resp["timer_active"] = False
        return jsonify(resp)

@app.route('/get_lyrics')
def get_lyrics():
    with state_lock:
        artist = request.args.get('artist') or st4_state.get("artist", "")
        title = request.args.get('title') or st4_state.get("title", "")
    
    if not title: return jsonify({"error": "No track info"})

    clean_title = re.sub(r"\(.*?\)|\[.*?\]|【.*?】", "", title).strip()
    headers = {"User-Agent": "ST4Player/1.0"}
    
    try:
        if not artist or artist == "Unknown Artist":
            url = "https://lrclib.net/api/search"
            resp = requests.get(url, params={"q": clean_title}, headers=headers, timeout=5)
            data = resp.json()
            if data and isinstance(data, list) and len(data) > 0:
                best_match = data[0]
                if best_match.get('syncedLyrics'): return jsonify({"type": "synced", "lyrics": best_match['syncedLyrics']})
                elif best_match.get('plainLyrics'): return jsonify({"type": "plain", "lyrics": best_match['plainLyrics']})
            return jsonify({"error": "Not found"})

        url = "https://lrclib.net/api/get"
        params = {"artist_name": artist, "track_name": clean_title}
        resp = requests.get(url, params=params, headers=headers, timeout=5)
        
        if resp.status_code == 404:
            url_search = "https://lrclib.net/api/search"
            resp_search = requests.get(url_search, params={"q": f"{artist} {clean_title}"}, headers=headers, timeout=5)
            data_search = resp_search.json()
            if data_search and isinstance(data_search, list) and len(data_search) > 0:
                best_match = data_search[0]
                if best_match.get('syncedLyrics'): return jsonify({"type": "synced", "lyrics": best_match['syncedLyrics']})
                elif best_match.get('plainLyrics'): return jsonify({"type": "plain", "lyrics": best_match['plainLyrics']})
            return jsonify({"error": "Not found"})
            
        data = resp.json()
        if data.get('syncedLyrics'): return jsonify({"type": "synced", "lyrics": data['syncedLyrics']})
        elif data.get('plainLyrics'): return jsonify({"type": "plain", "lyrics": data['plainLyrics']})
        else: return jsonify({"error": "Not found"})
            
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route('/bt/scan')
def bt_scan():
    try:
        subprocess.run("bluetoothctl scan off", shell=True)
        subprocess.run("bluetoothctl power on", shell=True)
        subprocess.run("timeout 10s bluetoothctl scan on", shell=True)
        
        out = subprocess.check_output("bluetoothctl devices", shell=True).decode()
        devices = []
        matches = re.findall(r"Device\s+([0-9A-F:]{17})\s+(.+)", out)
        for mac, name in matches:
            clean_name = name.strip()
            if clean_name.replace("-", ":") != mac: 
                devices.append({'mac': mac, 'name': clean_name})
        return jsonify(devices)
    except: return jsonify([])

@app.route('/bt/connect')
def bt_connect():
    mac = request.args.get('mac')
    if not mac or ";" in mac: return jsonify({"status":"error"})
    
    try:
        subprocess.run("pgrep bluealsa || bluealsa &", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1) 
        
        subprocess.run("bluetoothctl agent on", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run("bluetoothctl default-agent", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        subprocess.run(["bluetoothctl", "pair", mac], timeout=15, check=False)
        subprocess.run(["bluetoothctl", "trust", mac], check=False)
        
        subprocess.run(["bluetoothctl", "connect", mac], timeout=10, check=False)
        
        time.sleep(2)
        
        info = subprocess.check_output(f"bluetoothctl info {mac}", shell=True, text=True)
        
        if "Connected: yes" in info:
            dev_name = "Bluetooth Device"
            m = re.search(r"Name:\s+(.*)", info)
            if m: dev_name = m.group(1)

            dev_str = f"alsa/bluealsa:DEV={mac},PROFILE=a2dp"
            mpv_send(["set_property", "audio-device", dev_str])
            with open(MODE_FILE, "w") as f: f.write(dev_str)
            
            with state_lock:
                st4_state["connected_bt_mac"] = mac
                st4_state["connected_bt_name"] = dev_name
                st4_state["status_output"] = "bluetooth"
                
            return jsonify({"status":"ok", "name": dev_name})
        else:
            return jsonify({"status":"failed", "info": "Gagal terhubung. Coba restart TWS/Speaker lalu coba lagi."})
            
    except Exception as e: 
        return jsonify({"status":"error", "info": str(e)})

@app.route('/bt/disconnect')
def bt_disconnect():
    mac = request.args.get('mac')
    if mac: subprocess.run(["bluetoothctl", "disconnect", mac])
    return jsonify({"status":"ok"})

@app.route('/control/bitperfect')
def toggle_bitperfect():
    current = "0"
    if os.path.exists(BP_MODE_FILE):
        try:
            with open(BP_MODE_FILE, 'r') as f: current = f.read().strip()
        except: pass
    
    new_state = "1" if current == "0" else "0"
    with open(BP_MODE_FILE, 'w') as f: f.write(new_state)
    update_mpv_filters()
    
    if new_state == "0":
        mpv_send(["set_property", "volume", 30])
        with state_lock: st4_state["volume"] = 30

    return jsonify({"status": "ok", "bitperfect": new_state == "1"})

@app.route('/get_bitperfect')
def get_bitperfect():
    active = False
    if os.path.exists(BP_MODE_FILE):
        with open(BP_MODE_FILE, 'r') as f: active = f.read().strip() == "1"
    return jsonify({"active": active})

@app.route('/control/crossfeed')
def toggle_crossfeed():
    state = request.args.get('state', 'on')
    af_state["crossfeed"] = "lavfi=[bs2b=profile=cmoy]" if state == 'on' else ""
    update_mpv_filters()
    return jsonify({"status": "ok", "crossfeed": state == 'on'})

@app.route('/get_crossfeed')
def get_crossfeed():
    return jsonify({"active": len(af_state["crossfeed"]) > 0})

@app.route('/control/jump')
def jump_to_index():
    try:
        idx = int(request.args.get('index', -1))
        with state_lock:
            if 0 <= idx < len(st4_state["queue"]):
                st4_state["current_index"] = idx
                song = st4_state["queue"][idx]
                st4_state["error_count"] = 0
                threading.Thread(target=trigger_play, args=(song['link'],)).start()
                return jsonify({"status": "ok", "title": song['title']})
    except: pass
    return jsonify({"error": "invalid index"})

@app.route('/play', methods=['GET', 'POST'])
def play():
    url = request.args.get('url') or request.form.get('link')
    mode = request.args.get('mode', 'play_now')
    title = request.args.get('title', 'Unknown Title')
    if not url: return jsonify({"error": "no url"})
    song_obj = {'link': url, 'title': title}
    
    with state_lock:
        if mode == 'play_now':
            if os.path.exists(url) and os.path.isfile(url):
                folder_path = os.path.dirname(url)
                try:
                    folder_files = [f for f in os.listdir(folder_path) if f.lower().endswith(AUDIO_EXTS)]
                    folder_files.sort(key=lambda x: x.lower())
                    new_queue = []
                    target_index = 0
                    for idx, fname in enumerate(folder_files):
                        full_path = os.path.join(folder_path, fname)
                        new_queue.append({'link': full_path, 'title': fname})
                        if full_path == url: target_index = idx
                    st4_state["queue"] = new_queue
                    st4_state["current_index"] = target_index
                except:
                    st4_state["queue"] = [song_obj]; st4_state["current_index"] = 0
            elif "youtube.com" in url or "youtu.be" in url:
                st4_state["queue"] = [song_obj]; st4_state["current_index"] = 0
                try:
                    match = re.search(r"(?:v=|\/)([0-9A-Za-z_-]{11})", url)
                    video_id = match.group(1) if match else None
                    if video_id:
                        data = yt_music.get_watch_playlist(videoId=video_id, limit=20)
                        if 'tracks' in data:
                            new_queue = []
                            for t in data['tracks']:
                                vid = t.get('videoId')
                                if vid:
                                    t_artist = t['artists'][0]['name'] if 'artists' in t and t['artists'] else ""
                                    full_title = f"{t_artist} - {t['title']}" if t_artist else t['title']
                                    new_queue.append({'link': f"https://music.youtube.com/watch?v={vid}", 'title': full_title})
                            if new_queue: st4_state["queue"] = new_queue; st4_state["current_index"] = 0
                except: pass
            else:
                st4_state["queue"] = [song_obj]; st4_state["current_index"] = 0
            
            st4_state["error_count"] = 0
            threading.Thread(target=trigger_play, args=(url,)).start()
        elif mode == 'enqueue':
            st4_state["queue"].append(song_obj)
            if st4_state["status"] == "stopped" and len(st4_state["queue"]) == 1:
                st4_state["current_index"] = 0
                threading.Thread(target=trigger_play, args=(url,)).start()
    return jsonify({"status": "ok", "mode": mode, "queue_len": len(st4_state["queue"])})

@app.route('/control/<action>')
def control(action):
    if action == "pause": mpv_send(["cycle", "pause"])
    elif action == "stop":
        mpv_send(["stop"])
        with state_lock:
            st4_state["status"] = "stopped"
            st4_state["queue"] = []
            st4_state["current_index"] = -1
            st4_state["manual_stop"] = True
    elif action == "next": play_next_in_queue()
    elif action == "prev":
        with state_lock:
            if st4_state["current_index"] > 0:
                st4_state["current_index"] -= 1
                prev_song = st4_state["queue"][st4_state["current_index"]]
                trigger_play(prev_song['link'])
            else: mpv_send(["seek", 0, "absolute"])
    elif action == "shuffle":
        with state_lock:
            if len(st4_state["queue"]) > 1:
                current_song = st4_state["queue"][st4_state["current_index"]]
                random.shuffle(st4_state["queue"])
                for idx, song in enumerate(st4_state["queue"]):
                    if song['link'] == current_song['link']:
                        st4_state["current_index"] = idx; break
        return jsonify({"status": "shuffled"})
    elif action == "volume":
        try: 
            v = int(request.args.get('val', 30))
            mpv_send(["set_property", "volume", v])
            with state_lock: st4_state["volume"] = v
        except: pass
    elif action == "seek":
        try: mpv_send(["seek", float(request.args.get('val', 0)), "absolute-percent"])
        except: pass
    elif action == "output":
        target = request.args.get('mode') or 'jack'
        dev_string = get_audio_device_string(target)
        mpv_send(["set_property", "audio-device", dev_string])
        if os.path.exists(TOGGLE_SCRIPT): subprocess.run(["/bin/bash", TOGGLE_SCRIPT, dev_string], check=False)
        else:
            with open(MODE_FILE, "w") as f: f.write(dev_string)
        with state_lock: st4_state["status_output"] = target
        return jsonify({"status": "ok", "active": target})
    return jsonify({"status": "ok"})

def generate_fireq_cmd(gains_dict):
    freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    entries = []
    for i in range(1, 11):
        try: val = float(gains_dict.get(f'f{i}', 0))
        except: val = 0.0
        entries.append(f"entry({freqs[i-1]},{val})")
    return f"firequalizer=gain_entry='{';'.join(entries)}'"

@app.route('/control/eq')
def set_eq():
    p = request.args
    gains = {}
    for i in range(1, 11): gains[f'f{i}'] = p.get(f'f{i}', 0)
    cmd_str = generate_fireq_cmd(gains)
    af_state["eq"] = f"lavfi=[{cmd_str}]"
    update_mpv_filters()
    with state_lock: st4_state["current_eq_cmd"] = af_state["eq"]
    return jsonify({"status": "ok"})

@app.route('/control/preset')
def set_preset():
    n = request.args.get('name')
    if n in EQ_PRESETS:
        preset = EQ_PRESETS[n]
        cmd_str = generate_fireq_cmd(preset)
        af_state["eq"] = f"lavfi=[{cmd_str}]"
        update_mpv_filters()
        with state_lock: 
            st4_state["active_preset"] = n
            st4_state["current_eq_cmd"] = af_state["eq"]
        return jsonify(preset)
    return jsonify({"error": "not found"}), 404

@app.route('/queue/list')
def get_queue():
    with state_lock: return jsonify({"queue": st4_state["queue"], "current_index": st4_state["current_index"]})

@app.route('/queue/clear')
def clear_queue():
    with state_lock: st4_state["queue"] = []; st4_state["current_index"] = -1
    return jsonify({"status": "cleared"})

@app.route('/get_files')
def get_files():
    target = request.args.get('path', '/')
    items = []
    
    if target == '/':
        return jsonify([
            {'name': '🏠 Internal Storage (/root)', 'path': '/root', 'type': 'dir'},
            {'name': '💾 External HDD/USB (/mnt)', 'path': '/mnt', 'type': 'dir'}
        ])

    try:
        abs_path = os.path.abspath(target)
        
        if abs_path != '/':
            parent = os.path.dirname(abs_path)
            if abs_path in ['/root', '/mnt']:
                parent = '/'
            items.append({'name': '..', 'path': parent, 'type': 'dir'})
            
        with os.scandir(abs_path) as entries:
            entry_list = list(entries)
            entry_list.sort(key=lambda e: (not e.is_dir(), e.name.lower()))
            
            for entry in entry_list:
                if entry.name.startswith('.'): continue
                if entry.is_dir(): 
                    items.append({'name': entry.name, 'path': entry.path, 'type': 'dir'})
                elif entry.is_file() and entry.name.lower().endswith(AUDIO_EXTS):
                    items.append({'name': entry.name, 'path': entry.path, 'type': 'file'})
    except Exception as e: pass
    return jsonify(items)

@app.route('/search')
def search_yt():
    query = request.args.get('q', '')
    if not query: return jsonify([])
    try:
        results = yt_music.search(query, filter="videos", limit=30)
        data = []
        for r in results:
            thumb = r['thumbnails'][-1]['url'] if 'thumbnails' in r else ""
            artists = ", ".join([a['name'] for a in r.get('artists', [])])
            data.append({'title': r.get('title'), 'artist': artists, 'duration': r.get('duration',''), 'thumb': thumb, 'link': f"https://music.youtube.com/watch?v={r['videoId']}", 'videoId': r['videoId']})
        return jsonify(data)
    except: return jsonify([])

@app.route('/system/default_path', methods=['GET', 'POST'])
def handle_default_path():
    if request.method == 'POST':
        try:
            data = request.json; new_path = data.get('path', '/root')
            if os.path.exists(new_path):
                with open(DEFAULT_PATH_FILE, 'w') as f: f.write(new_path)
                return jsonify({"status": "ok", "path": new_path})
            else: return jsonify({"error": "Path not found"}), 404
        except Exception as e: return jsonify({"error": str(e)}), 500
    else:
        path = "/root/music"
        if os.path.exists(DEFAULT_PATH_FILE):
            try:
                with open(DEFAULT_PATH_FILE, 'r') as f: path = f.read().strip()
            except: pass
        return jsonify({"path": path})

@app.route('/system/timer')
def set_timer():
    try: minutes = int(request.args.get('min', 0))
    except: minutes = 0
    with state_lock: st4_state["sleep_target"] = (time.time() + minutes*60) if minutes > 0 else 0
    return jsonify({"status": "ok", "timer": minutes})

@app.route('/get_playlist')
def get_playlist():
    if os.path.exists(PLAYLIST_FILE):
        try:
            with open(PLAYLIST_FILE, 'r') as f: return jsonify(json.load(f))
        except: pass
    return jsonify([])

@app.route('/save_playlist', methods=['POST'])
def save_playlist():
    try:
        with open(PLAYLIST_FILE, 'w') as f: json.dump(request.json, f)
        return jsonify({"status": "ok"})
    except: return jsonify({"error": "failed"}), 500

@app.route('/control/balance')
def set_balance():
    try:
        l_vol = float(request.args.get('l', 1.0))
        r_vol = float(request.args.get('r', 1.0))
    except:
        l_vol = 1.0; r_vol = 1.0

    pan_cmd = f"pan=stereo|c0={l_vol:.2f}*c0|c1={r_vol:.2f}*c1"
    
    if l_vol >= 0.99 and r_vol >= 0.99: af_state["balance"] = ""
    else: af_state["balance"] = f"lavfi=[{pan_cmd}]"
    
    update_mpv_filters()
    return jsonify({"status": "ok", "L": l_vol, "R": r_vol})

@app.route('/library/scan')
def scan_library():
    if lib_mgr:
        scan_path = "/root/music"
        if os.path.exists(DEFAULT_PATH_FILE):
            try:
                with open(DEFAULT_PATH_FILE, 'r') as f: scan_path = f.read().strip()
            except: pass
            
        lib_mgr.scan_directory(scan_path)
        return jsonify({"status": "started", "path": scan_path})
    return jsonify({"status": "disabled"})

@app.route('/library/status')
def library_status():
    if lib_mgr: return jsonify(lib_mgr.get_scan_status())
    return jsonify({"status": "disabled"})

@app.route('/library/tracks')
def library_tracks():
    if not lib_mgr: return jsonify([])
    sort_mode = request.args.get('sort', 'title')
    tracks = lib_mgr.get_all_tracks(sort_mode)
    
    formatted = []
    for t in tracks:
        formatted.append({
            'name': t['title'],
            'path': t['path'],
            'type': 'file',
            'artist': t['artist'],
            'album': t['album'],
            'meta': f"{t['artist']} - {t['album']}"
        })
    return jsonify(formatted)

@app.route('/library/search_db')
def search_db():
    if not lib_mgr: return jsonify([])
    q = request.args.get('q', '')
    if not q: return jsonify([])
    
    results = lib_mgr.search_tracks(q)
    formatted = []
    for t in results:
        formatted.append({
            'title': t['title'],
            'artist': t['artist'],
            'album': t['album'],
            'link': t['path'],
            'thumb': '/static/img/default.png', 
            'is_local': True
        })
    return jsonify(results)

# ========================
# BROWSER MODE ENDPOINTS (same server, different logic - no mpv)
# ========================

@app.route('/play/current')
def play_current():
    with state_lock:
        idx = st4_state["current_index"]
        if 0 <= idx < len(st4_state["queue"]):
            s = st4_state["queue"][idx]
            return jsonify({"index": idx, "title": s['title'], "link": s['link'], "thumb": st4_state.get("thumb", "")})
        return jsonify({"index": -1})

@app.route('/browser_play', methods=['GET', 'POST'])
def browser_play():
    """Browser mode: update queue ONLY, no mpv."""
    url = request.args.get('url') or request.form.get('link')
    mode = request.args.get('mode', 'play_now')
    title = request.args.get('title', 'Unknown Title')
    if not url: return jsonify({"error": "no url"})
    song_obj = {'link': url, 'title': title}

    if mode == 'play_now':
        if os.path.exists(url) and os.path.isfile(url):
            folder_path = os.path.dirname(url)
            try:
                folder_files = [f for f in os.listdir(folder_path) if f.lower().endswith(AUDIO_EXTS)]
                folder_files.sort(key=lambda x: x.lower())
                new_queue = []
                target_index = 0
                for idx, fname in enumerate(folder_files):
                    full_path = os.path.join(folder_path, fname)
                    new_queue.append({'link': full_path, 'title': fname})
                    if full_path == url: target_index = idx
                st4_state["queue"] = new_queue
                st4_state["current_index"] = target_index
            except:
                st4_state["queue"] = [song_obj]; st4_state["current_index"] = 0
        elif "youtube.com" in url or "youtu.be" in url:
            st4_state["queue"] = [song_obj]; st4_state["current_index"] = 0
            try:
                match = re.search(r"(?:v=|\/)([0-9A-Za-z_-]{11})", url)
                video_id = match.group(1) if match else None
                if video_id:
                    data = yt_music.get_watch_playlist(videoId=video_id, limit=20)
                    if 'tracks' in data:
                        new_queue = []
                        for t in data['tracks']:
                            vid = t.get('videoId')
                            if vid:
                                t_artist = t['artists'][0]['name'] if 'artists' in t and t['artists'] else ""
                                full_title = f"{t_artist} - {t['title']}" if t_artist else t['title']
                                new_queue.append({'link': f"https://music.youtube.com/watch?v={vid}", 'title': full_title})
                        if new_queue: st4_state["queue"] = new_queue; st4_state["current_index"] = 0
            except: pass
        else:
            st4_state["queue"] = [song_obj]; st4_state["current_index"] = 0
        
        st4_state["status"] = "playing"
    elif mode == 'enqueue':
        st4_state["queue"].append(song_obj)
    
    return jsonify({"status": "ok", "mode": mode, "queue_len": len(st4_state["queue"])})

@app.route('/play/next_browser')
def next_browser():
    """Browser mode: advance queue without mpv."""
    if not st4_state["queue"]:
        return jsonify({"index": -1})
    next_idx = st4_state["current_index"] + 1
    if next_idx < len(st4_state["queue"]):
        st4_state["current_index"] = next_idx
        next_song = st4_state["queue"][next_idx]
        return jsonify({"index": next_idx, "title": next_song['title'], "link": next_song['link'], "thumb": ""})
    else:
        st4_state["status"] = "stopped"
        return jsonify({"index": -1})

@app.route('/youtube_proxy')
def youtube_proxy():
    """Stream YouTube audio directly using yt-dlp without downloading to disk."""
    url = request.args.get('url', '')
    if not url: return jsonify({"error": "no url"}), 400
    try:
        import yt_dlp
        ydl_opts = {'format': 'bestaudio/best', 'quiet': True, 'no_warnings': True, 'youtube_include_dash_manifest': False}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            direct_url = info.get('url', '')
        if not direct_url: return jsonify({"error": "could not extract audio URL"}), 500
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Range': request.headers.get('Range', 'bytes=0-')}
        resp = requests.get(direct_url, headers=headers, stream=True, timeout=30)
        def generate():
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk: yield chunk
        response = Response(stream_with_context(generate()), status=resp.status_code, content_type=resp.headers.get('Content-Type', 'audio/webm'))
        if 'Content-Range' in resp.headers: response.headers['Content-Range'] = resp.headers['Content-Range']
        if 'Content-Length' in resp.headers: response.headers['Content-Length'] = resp.headers['Content-Length']
        if 'Accept-Ranges' in resp.headers: response.headers['Accept-Ranges'] = resp.headers['Accept-Ranges']
        return response
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/radio_proxy')
def radio_proxy():
    """Proxy radio streams to avoid CORS issues in browser mode."""
    url = request.args.get('url', '')
    if not url: return jsonify({"error": "no url"}), 400
    try:
        headers = {'User-Agent': 'Mozilla/5.0', 'Accept': '*/*'}
        resp = requests.get(url, headers=headers, stream=True, timeout=30)
        def generate():
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk: yield chunk
        return Response(stream_with_context(generate()), status=resp.status_code, content_type=resp.headers.get('Content-Type', 'audio/mpeg'))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/stream')
def stream_file():
    """Stream local file with HTTP Range support."""
    path = request.args.get('path', '')
    if not path or not os.path.exists(path): abort(404)
    range_header = request.headers.get('Range', None)
    file_size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    mime_map = {'.mp3':'audio/mpeg','.flac':'audio/flac','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.opus':'audio/ogg','.wma':'audio/x-ms-wma','.aac':'audio/aac'}
    mime = mime_map.get(ext, 'audio/mpeg')
    if range_header:
        m = re.search(r'(\d+)-(\d*)', range_header)
        if m:
            byte1 = int(m.group(1)); byte2 = int(m.group(2)) if m.group(2) else file_size-1
            length = byte2 - byte1 + 1
            with open(path, 'rb') as f: f.seek(byte1); data = f.read(length)
            resp = Response(data, 206, mimetype=mime, content_type=mime, direct_passthrough=True)
            resp.headers.add('Content-Range', f'bytes {byte1}-{byte2}/{file_size}')
            resp.headers.add('Accept-Ranges', 'bytes'); resp.headers.add('Content-Length', str(length))
            return resp
    return send_file(path, mimetype=mime)

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files: return jsonify({"error":"no file"}),400
    f = request.files['file']
    if not f.filename: return jsonify({"error":"no filename"}),400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in AUDIO_EXTS: return jsonify({"error":"unsupported format"}),400
    uid = str(uuid.uuid4())[:8]
    safe_name = f"{uid}_{f.filename}"
    f.save(os.path.join(UPLOAD_DIR, safe_name))
    return jsonify({"status":"ok","filename":safe_name,"path":os.path.join(UPLOAD_DIR, safe_name)})

@app.route('/uploads')
def list_uploads():
    files = []
    if os.path.exists(UPLOAD_DIR):
        for fn in sorted(os.listdir(UPLOAD_DIR), key=lambda x: os.path.getmtime(os.path.join(UPLOAD_DIR, x)), reverse=True):
            fp = os.path.join(UPLOAD_DIR, fn)
            if os.path.isfile(fp) and fn.lower().endswith(AUDIO_EXTS):
                files.append({"name":fn, "path":fp, "size":os.path.getsize(fp)})
    return jsonify(files)

@app.route('/playlist/export_m3u')
def export_m3u():
    """Export current queue as M3U file."""
    from io import StringIO
    if not st4_state["queue"]:
        return jsonify({"error": "empty queue"}), 404
    lines = ["#EXTM3U"]
    for item in st4_state["queue"]:
        lines.append(f"#EXTINF:-1,{item['title']}")
        lines.append(item['link'])
    content = "\n".join(lines)
    return Response(content, mimetype='audio/x-mpegurl', headers={'Content-Disposition': 'attachment; filename=playlist.m3u'})

@app.route('/playlist/import_m3u', methods=['POST'])
def import_m3u():
    """Import M3U/M3U8/PLS playlist."""
    try:
        text = request.get_data(as_text=True)
        if not text: return jsonify({"status": "error", "info": "empty"}), 400
        lines = text.strip().split('\n')
        imported = 0
        for line in lines:
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('['): continue
            if line.startswith('http') or os.path.exists(line):
                st4_state["queue"].append({'link': line, 'title': "Unknown"})
                imported += 1
        if imported > 0 and st4_state["status"] == "stopped":
            st4_state["current_index"] = 0
        return jsonify({"status": "ok", "imported": imported})
    except Exception as e:
        return jsonify({"status": "error", "info": str(e)}), 500

if __name__ == '__main__':
    import subprocess
    subprocess.run("pgrep bluealsa || bluealsa -p a2dp-source -p a2dp-sink &", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    app.run(host='0.0.0.0', port=2030, debug=False)