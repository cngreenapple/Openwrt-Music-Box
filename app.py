from flask import Flask, render_template, request, jsonify, send_file, Response, abort
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
import logging
from threading import Lock
from ytmusicapi import YTMusic

try:
    from library import lib_mgr
except ImportError:
    lib_mgr = None

OWRTMB_PORT = int(os.environ.get('OWRTMB_PORT', 2030))
OWRTMB_HOST = os.environ.get('OWRTMB_HOST', '0.0.0.0')
OWRTMB_LOG_LEVEL = os.environ.get('OWRTMB_LOG_LEVEL', 'INFO').upper()

log_level = getattr(logging, OWRTMB_LOG_LEVEL, logging.INFO)
logging.basicConfig(level=log_level, format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    handlers=[logging.StreamHandler(), logging.FileHandler('owrt_musicbox.log')])
logger = logging.getLogger('OwrtMusicBox')
logger.info(f"Starting on {OWRTMB_HOST}:{OWRTMB_PORT}")

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MPV_SOCKET = "/tmp/mpv_socket"
PLAYLIST_FILE = os.path.join(BASE_DIR, "playlist.json")
COVER_DIR = os.path.join(BASE_DIR, "static", "covers")
PLAY_SCRIPT = os.path.join(BASE_DIR, "play.sh")
MODE_FILE = "/root/output_mode"
BP_MODE_FILE = "/root/bp_mode"
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
AUDIO_EXTS = ('.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus', '.wma', '.aac', '.dsf', '.dff')
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

state_lock = Lock()
yt_music = YTMusic()
needs_restore = False

app_state = {
    "title": "Ready", "artist": "Waiting...", "album": "", "genre": "", "year": "",
    "tech_info": "", "current_time": 0, "total_time": 0, "status": "stopped",
    "volume": 50, "status_output": "jack", "active_preset": "Normal",
    "thumb": "", "queue": [], "current_index": -1, "sleep_target": 0,
    "connected_bt_mac": "", "connected_bt_name": "", "last_play_time": 0,
    "error_count": 0, "manual_stop": False, "play_mode": "server"
}

af_state = {"eq": "", "balance": "", "crossfeed": ""}

EQ_PRESETS = {
    "Normal": {"f1":0,"f2":0,"f3":0,"f4":0,"f5":0,"f6":0,"f7":0,"f8":0,"f9":0,"f10":0},
    "Bass":   {"f1":7,"f2":6,"f3":5,"f4":3,"f5":0,"f6":0,"f7":0,"f8":-1,"f9":-2,"f10":-3},
    "Rock":   {"f1":5,"f2":3,"f3":1,"f4":-1,"f5":-2,"f6":0,"f7":2,"f8":4,"f9":5,"f10":5},
    "Pop":    {"f1":-1,"f2":1,"f3":3,"f4":4,"f5":4,"f6":2,"f7":0,"f8":1,"f9":2,"f10":2},
    "Jazz":   {"f1":2,"f2":2,"f3":4,"f4":2,"f5":2,"f6":4,"f7":2,"f8":2,"f9":3,"f10":3},
    "Vocal":  {"f1":-3,"f2":-3,"f3":-2,"f4":0,"f5":4,"f6":6,"f7":5,"f8":3,"f9":1,"f10":-1},
    "Metal":  {"f1":6,"f2":5,"f3":0,"f4":-2,"f5":-3,"f6":0,"f7":3,"f8":6,"f9":7,"f10":7},
    "Classic":{"f1":4,"f2":3,"f3":2,"f4":2,"f5":-1,"f6":-1,"f7":0,"f8":2,"f9":3,"f10":4},
}

def update_mpv_filters():
    filters = []
    if af_state["eq"]: filters.append(af_state["eq"])
    if af_state["balance"]: filters.append(af_state["balance"])
    if af_state["crossfeed"]: filters.append(af_state["crossfeed"])
    cmd = ",".join(filters) if filters else ""
    mpv_send(["set_property", "af", cmd])

def mpv_send(cmd):
    if not os.path.exists(MPV_SOCKET): return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(0.2); s.connect(MPV_SOCKET)
        s.send((json.dumps({"command": cmd}) + "\n").encode())
        res = s.recv(8192).decode(); s.close()
        return json.loads(res).get("data")
    except: return None

def generate_fireq_cmd(gains_dict):
    freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    entries = []
    for i in range(1, 11):
        try: val = float(gains_dict.get(f'f{i}', 0))
        except: val = 0.0
        entries.append(f"entry({freqs[i-1]},{val})")
    return f"firequalizer=gain_entry='{';'.join(entries)}'"

def get_yt_thumb(url):
    match = re.search(r"([a-zA-Z0-9_-]{11})", url or "")
    if match: return f"https://img.youtube.com/vi/{match.group(1)}/0.jpg"
    return ""

def extract_local_cover(filepath):
    if not filepath or not os.path.exists(filepath): return ""
    try:
        hash_name = hashlib.md5(filepath.encode()).hexdigest()
        save_path = os.path.join(COVER_DIR, f"{hash_name}.jpg")
        if os.path.exists(save_path): return f"/static/covers/{hash_name}.jpg"
        if os.path.getsize(filepath) < 102400: return ""
        subprocess.run(["ffmpeg","-i",filepath,"-an","-vcodec","mjpeg","-q:v","2","-frames:v","1","-y",save_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if os.path.exists(save_path): return f"/static/covers/{hash_name}.jpg"
    except: pass
    return ""

def get_connected_bt():
    try:
        out = subprocess.check_output("bluetoothctl info", shell=True).decode()
        if "Connected: yes" in out:
            mac = re.search(r"Device\s+([0-9A-F:]{17})", out)
            name = re.search(r"Name:\s+(.*)", out)
            if mac: return mac.group(1), name.group(1) if name else "Unknown"
    except: pass
    return None, None

def trigger_server_play(url):
    global needs_restore
    with state_lock:
        app_state["last_play_time"] = time.time()
        app_state["thumb"] = get_yt_thumb(url) if "http" in url else ""
        app_state["status"] = "loading"
        app_state["manual_stop"] = False
    needs_restore = True
    subprocess.Popen(["/bin/bash", PLAY_SCRIPT, url] if os.path.exists(PLAY_SCRIPT) else ["mpv", url])

def play_next():
    with state_lock:
        if not app_state["queue"]: return
        t = time.time() - app_state.get("last_play_time", 0)
        if t < 2: app_state["error_count"] += 1
        else: app_state["error_count"] = 0
        if app_state["error_count"] > 5: app_state["status"] = "stopped"; return
        nx = app_state["current_index"] + 1
        if nx < len(app_state["queue"]):
            app_state["current_index"] = nx
            s = app_state["queue"][nx]
            if app_state["play_mode"] == "browser" and os.path.exists(s['link']):
                app_state["status"] = "playing"
                app_state["title"] = s['title']
            else:
                threading.Thread(target=trigger_server_play, args=(s['link'],)).start()
        else: app_state["status"] = "stopped"

# === METADATA WORKER (CRITICAL untuk audio) ===
def metadata_worker():
    global needs_restore
    last_path = ""
    idle_counter = 0
    if not os.path.exists(COVER_DIR): os.makedirs(COVER_DIR, exist_ok=True)
    while True:
        try:
            bt_mac, bt_name = get_connected_bt()
            with state_lock:
                app_state["connected_bt_mac"] = bt_mac or ""
                app_state["connected_bt_name"] = bt_name or ""
            # Sleep timer
            with state_lock:
                target = app_state["sleep_target"]
                if target > 0 and time.time() >= target:
                    app_state["sleep_target"] = 0
                    app_state["queue"] = []
                    app_state["current_index"] = -1
                    threading.Thread(target=mpv_send, args=(["stop"],)).start()
            mpv_ready = False
            try:
                if mpv_send(["get_property", "idle-active"]) is not None: mpv_ready = True
            except: pass
            if mpv_ready:
                idle_counter = 0
                path = mpv_send(["get_property", "path"])
                if path and (path != last_path or needs_restore):
                    last_path = path
                    needs_restore = False
                    time.sleep(0.8)  # Beri waktu MPV settle
                    with state_lock: saved_vol = app_state["volume"]
                    mpv_send(["set_property", "volume", saved_vol])
                    update_mpv_filters()
                is_eof = mpv_send(["get_property", "eof-reached"])
                is_idle = mpv_send(["get_property", "idle-active"])
                with state_lock:
                    cm = app_state.get("manual_stop", False)
                    cs = app_state.get("status", "stopped")
                if cm and is_idle:
                    with state_lock: app_state["manual_stop"] = False
                elif is_eof is True or (is_idle is True and cs == "playing"):
                    play_next(); time.sleep(1); continue
                # Metadata
                queue_title = "Unknown Title"
                with state_lock:
                    if app_state["queue"] and app_state["current_index"] < len(app_state["queue"]):
                        queue_title = app_state["queue"][app_state["current_index"]].get('title', 'Unknown Title')
                meta = mpv_send(["get_property", "metadata"]) or {}
                mpv_title = mpv_send(["get_property", "media-title"])
                final_title = queue_title
                if mpv_title:
                    junk = any(x in mpv_title.lower() for x in ["http","www.",".com","webm&","googlevideo","?source"])
                    if not junk: final_title = mpv_title
                # Extract artist from title if not in metadata
                artist = ""
                for k in ["artist","performer","composer"]:
                    for dk, dv in meta.items():
                        if dk.lower() == k.lower(): artist = dv; break
                    if artist: break
                if not artist or artist.lower() == "unknown artist":
                    if " - " in (queue_title if " - " in queue_title else final_title):
                        parts = (queue_title if " - " in queue_title else final_title).split(" - ", 1)
                        artist = parts[0].strip()
                        final_title = parts[1].strip()
                    else: artist = "Unknown Artist"
                album = ""
                for dk, dv in meta.items():
                    if dk.lower() == "album": album = dv; break
                # Tech info
                codec = (mpv_send(["get_property","audio-codec-name"]) or "UNK").upper()
                br = mpv_send(["get_property","audio-bitrate"])
                br_str = f"{int(br)//1000}kbps" if br and int(br)>0 else ""
                rate = mpv_send(["get_property","audio-params/samplerate"])
                freq = f"{float(rate)/1000:g}kHz" if rate else ""
                fmt = mpv_send(["get_property","audio-params/format"]) or ""
                bit_depth = ""
                if 's24' in fmt: bit_depth = "24bit"
                elif 's32' in fmt or 'float' in fmt: bit_depth = "32bit"
                elif 's16' in fmt: bit_depth = "16bit"
                parts_list = [codec]
                if br_str: parts_list.append(br_str)
                if freq: parts_list.append(freq)
                if bit_depth: parts_list.append(bit_depth)
                tech = " • ".join(parts_list)
                paused = mpv_send(["get_property","pause"])
                status = "paused" if paused else "playing"
                with state_lock:
                    app_state.update({
                        "title": final_title, "artist": artist, "album": album,
                        "status": status, "tech_info": tech,
                        "current_time": mpv_send(["get_property","time-pos"]) or 0,
                        "total_time": mpv_send(["get_property","duration"]) or 0
                    })
                    vol = mpv_send(["get_property","volume"])
                    if vol is not None: app_state["volume"] = vol
            else:
                idle_counter += 1
                if idle_counter == 5:
                    with state_lock: app_state["status"] = "stopped"
                with state_lock: ist = app_state["status"]
                if idle_counter == 15 and ist != "stopped": play_next()
        except Exception as e:
            logger.error(f"metadata_worker error: {e}")
        time.sleep(1)

threading.Thread(target=metadata_worker, daemon=True).start()

# === ROUTES ===
@app.route('/')
def index(): return render_template('index.html')

@app.route('/status')
def status():
    with state_lock:
        r = dict(app_state)
        t = r.get("sleep_target", 0)
        if t > 0:
            rem = int(t - time.time())
            r["timer_display"] = f"{int(rem/60)+1}m" if rem > 0 else "OFF"
            r["timer_active"] = rem > 0
        else: r["timer_display"] = "OFF"; r["timer_active"] = False
        return jsonify(r)

@app.route('/stream')
def stream_file():
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
            resp.headers.add('Accept-Ranges', 'bytes')
            resp.headers.add('Content-Length', str(length))
            return resp
    return send_file(path, mimetype=mime)

@app.route('/get_lyrics')
def get_lyrics():
    with state_lock: artist = app_state.get("artist",""); title = app_state.get("title","")
    if not title: return jsonify({"error":"No track info"})
    ct = re.sub(r"\(.*?\)|\[.*?\]|【.*?】", "", title).strip()
    h = {"User-Agent":"OwrtMusicBox/1.0"}
    try:
        if not artist or artist == "Unknown Artist":
            resp = requests.get("https://lrclib.net/api/search", params={"q": ct}, headers=h, timeout=5).json()
            if resp and isinstance(resp,list) and resp[0].get('syncedLyrics'): return jsonify({"type":"synced","lyrics":resp[0]['syncedLyrics']})
            if resp and isinstance(resp,list) and resp[0].get('plainLyrics'): return jsonify({"type":"plain","lyrics":resp[0]['plainLyrics']})
            return jsonify({"error":"Not found"})
        resp = requests.get("https://lrclib.net/api/get", params={"artist_name":artist,"track_name":ct}, headers=h, timeout=5)
        if resp.status_code == 404:
            resp = requests.get("https://lrclib.net/api/search", params={"q":f"{artist} {ct}"}, headers=h, timeout=5).json()
            if resp and isinstance(resp,list) and resp[0].get('syncedLyrics'): return jsonify({"type":"synced","lyrics":resp[0]['syncedLyrics']})
            if resp and isinstance(resp,list) and resp[0].get('plainLyrics'): return jsonify({"type":"plain","lyrics":resp[0]['plainLyrics']})
            return jsonify({"error":"Not found"})
        d = resp.json()
        if d.get('syncedLyrics'): return jsonify({"type":"synced","lyrics":d['syncedLyrics']})
        if d.get('plainLyrics'): return jsonify({"type":"plain","lyrics":d['plainLyrics']})
        return jsonify({"error":"Not found"})
    except: return jsonify({"error":"Request failed"})

@app.route('/bt/scan')
def bt_scan():
    try:
        subprocess.run("bluetoothctl scan off", shell=True)
        subprocess.run("bluetoothctl power on", shell=True)
        subprocess.run("timeout 10s bluetoothctl scan on", shell=True)
        out = subprocess.check_output("bluetoothctl devices", shell=True).decode()
        devs = []
        for m,n in re.findall(r"Device\s+([0-9A-F:]{17})\s+(.+)", out):
            n = n.strip()
            if n.replace("-",":") != m: devs.append({'mac':m,'name':n})
        return jsonify(devs)
    except: return jsonify([])

@app.route('/bt/connect')
def bt_connect():
    mac = request.args.get('mac')
    if not mac: return jsonify({"status":"error"})
    try:
        subprocess.run("pgrep bluealsa || bluealsa &", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        subprocess.run("bluetoothctl agent on", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run("bluetoothctl default-agent", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["bluetoothctl","pair",mac], timeout=15, check=False)
        subprocess.run(["bluetoothctl","trust",mac], check=False)
        subprocess.run(["bluetoothctl","connect",mac], timeout=10, check=False)
        time.sleep(2)
        info = subprocess.check_output(f"bluetoothctl info {mac}", shell=True, text=True)
        if "Connected: yes" in info:
            m = re.search(r"Name:\s+(.*)", info)
            name = m.group(1) if m else "Bluetooth Device"
            with state_lock: app_state["connected_bt_mac"] = mac; app_state["connected_bt_name"] = name; app_state["status_output"] = "bluetooth"
            return jsonify({"status":"ok","name":name})
        return jsonify({"status":"failed"})
    except: return jsonify({"status":"error"})

@app.route('/bt/disconnect')
def bt_disconnect():
    mac = request.args.get('mac')
    if mac: subprocess.run(["bluetoothctl","disconnect",mac])
    return jsonify({"status":"ok"})

@app.route('/control/<action>')
def control(action):
    if action == "pause":
        mpv_send(["cycle","pause"])
        with state_lock: app_state["status"] = "paused" if app_state["status"]=="playing" else "playing"
    elif action == "stop":
        mpv_send(["stop"])
        with state_lock: app_state["status"]="stopped"; app_state["queue"]=[]; app_state["current_index"]=-1; app_state["manual_stop"]=True
    elif action == "next": play_next()
    elif action == "prev":
        with state_lock:
            if app_state["current_index"]>0: app_state["current_index"]-=1; trigger_server_play(app_state["queue"][app_state["current_index"]]['link'])
            else: mpv_send(["seek",0,"absolute"])
    elif action == "shuffle":
        with state_lock:
            if len(app_state["queue"])>1:
                cur=app_state["queue"][app_state["current_index"]]
                random.shuffle(app_state["queue"])
                for i,s in enumerate(app_state["queue"]):
                    if s['link']==cur['link']: app_state["current_index"]=i; break
    elif action == "volume":
        try: v=int(request.args.get('val',50)); mpv_send(["set_property","volume",v]); app_state["volume"]=v
        except: pass
    elif action == "seek":
        try: mpv_send(["seek",float(request.args.get('val',0)),"absolute-percent"])
        except: pass
    elif action == "output":
        target = request.args.get('mode') or 'jack'
        dev_map = {"jack":"alsa/plughw:1,2","hdmi":"alsa/plughw:2,0","bluetooth":f"alsa/bluealsa:DEV={app_state.get('connected_bt_mac','')},PROFILE=a2dp"}
        dev = dev_map.get(target, "alsa/plughw:1,2")
        mpv_send(["set_property","audio-device",dev])
        open(MODE_FILE,'w').write(dev)
        with state_lock: app_state["status_output"] = target
        return jsonify({"status":"ok","active":target})
    return jsonify({"status":"ok"})

@app.route('/play', methods=['GET','POST'])
def play():
    url = request.args.get('url') or request.form.get('link')
    mode = request.args.get('mode','play_now')
    title = request.args.get('title','Unknown')
    if not url: return jsonify({"error":"no url"})
    with state_lock:
        if mode == 'play_now':
            app_state["queue"] = [{'link':url, 'title':title}]
            app_state["current_index"] = 0
            app_state["error_count"] = 0
            if app_state["play_mode"] == "browser" and os.path.exists(url):
                app_state["status"] = "playing"; app_state["title"] = title
            else:
                threading.Thread(target=trigger_server_play, args=(url,)).start()
        elif mode == 'enqueue':
            app_state["queue"].append({'link':url, 'title':title})
            if app_state["status"]=="stopped" and len(app_state["queue"])==1:
                app_state["current_index"]=0; threading.Thread(target=trigger_server_play, args=(url,)).start()
    return jsonify({"status":"ok","mode":mode,"queue_len":len(app_state["queue"])})

@app.route('/play/mode')
def set_play_mode():
    mode = request.args.get('mode','server')
    with state_lock: app_state["play_mode"] = mode
    if mode == "browser": mpv_send(["stop"])
    return jsonify({"status":"ok","mode":mode})

@app.route('/play/current')
def play_current():
    with state_lock:
        idx = app_state["current_index"]
        if 0 <= idx < len(app_state["queue"]):
            s = app_state["queue"][idx]
            return jsonify({"index":idx,"title":s['title'],"link":s['link'],"thumb":app_state["thumb"]})
        return jsonify({"index":-1})

@app.route('/play/next_browser')
def next_browser():
    play_next()
    return play_current()

@app.route('/control/eq')
def set_eq():
    p = request.args; g = {}
    for i in range(1,11): g[f'f{i}'] = p.get(f'f{i}',0)
    af_state["eq"] = f"lavfi=[{generate_fireq_cmd(g)}]"
    update_mpv_filters()
    return jsonify({"status":"ok"})

@app.route('/control/preset')
def set_preset():
    n = request.args.get('name')
    if n in EQ_PRESETS:
        p = EQ_PRESETS[n]
        af_state["eq"] = f"lavfi=[{generate_fireq_cmd(p)}]"
        update_mpv_filters()
        with state_lock: app_state["active_preset"] = n
        return jsonify(p)
    return jsonify({"error":"not found"}),404

@app.route('/control/bitperfect')
def toggle_bitperfect():
    c = "0"
    if os.path.exists(BP_MODE_FILE):
        try: c = open(BP_MODE_FILE).read().strip()
        except: pass
    n = "1" if c=="0" else "0"
    open(BP_MODE_FILE,'w').write(n)
    return jsonify({"status":"ok","bitperfect":n=="1"})

@app.route('/get_bitperfect')
def get_bitperfect():
    a = False
    if os.path.exists(BP_MODE_FILE): a = open(BP_MODE_FILE).read().strip()=="1"
    return jsonify({"active":a})

@app.route('/control/crossfeed')
def toggle_crossfeed():
    state = request.args.get('state','on')
    af_state["crossfeed"] = "lavfi=[bs2b=profile=cmoy]" if state=='on' else ""
    update_mpv_filters()
    return jsonify({"status":"ok","crossfeed":state=='on'})

@app.route('/get_crossfeed')
def get_crossfeed():
    return jsonify({"active":len(af_state["crossfeed"])>0})

@app.route('/queue/list')
def get_queue():
    with state_lock: return jsonify({"queue":app_state["queue"],"current_index":app_state["current_index"]})

@app.route('/queue/clear')
def clear_queue():
    with state_lock: app_state["queue"]=[]; app_state["current_index"]=-1
    return jsonify({"status":"cleared"})

@app.route('/get_files')
def get_files():
    t = request.args.get('path','/')
    if t == '/': return jsonify([
        {'name':'🏠 Internal (/root)','path':'/root','type':'dir'},
        {'name':'💾 External (/mnt)','path':'/mnt','type':'dir'},
        {'name':'📁 Uploads','path':UPLOAD_DIR,'type':'dir'},
        {'name':'🎵 Music Library','path':'/root/music','type':'dir'}
    ])
    items = []
    try:
        ap = os.path.abspath(t)
        if ap != '/':
            p = os.path.dirname(ap)
            if ap in ['/root','/mnt']: p='/'
            items.append({'name':'..','path':p,'type':'dir'})
        with os.scandir(ap) as es:
            es = sorted(es, key=lambda e: (not e.is_dir(), e.name.lower()))
            for e in es:
                if e.name.startswith('.'): continue
                if e.is_dir(): items.append({'name':e.name,'path':e.path,'type':'dir'})
                elif e.is_file() and e.name.lower().endswith(AUDIO_EXTS): items.append({'name':e.name,'path':e.path,'type':'file'})
    except: pass
    return jsonify(items)

@app.route('/search')
def search_yt():
    q = request.args.get('q','')
    if not q: return jsonify([])
    try:
        r = yt_music.search(q, filter="videos", limit=30)
        d = []
        for s in r:
            d.append({'title':s.get('title'),'artist':", ".join([a['name'] for a in s.get('artists',[])]),
                'duration':s.get('duration',''),'thumb':s['thumbnails'][-1]['url'] if 'thumbnails' in s else '',
                'link':f"https://music.youtube.com/watch?v={s['videoId']}"})
        return jsonify(d)
    except: return jsonify([])

@app.route('/system/timer')
def set_timer():
    try: m = int(request.args.get('min',0))
    except: m=0
    with state_lock: app_state["sleep_target"] = (time.time()+m*60) if m>0 else 0
    return jsonify({"status":"ok","timer":m})

@app.route('/playlist/export_m3u')
def export_m3u():
    with state_lock: t = app_state["queue"]
    l = ["#EXTM3U"]
    for s in t: l.append(f"#EXTINF:-1,{s.get('title','Unknown')}"); l.append(s.get('link',''))
    return "\n".join(l), 200, {"Content-Type":"text/plain;charset=utf-8","Content-Disposition":"attachment;filename=playlist.m3u"}

@app.route('/playlist/import_m3u', methods=['POST'])
def import_m3u():
    data = request.get_data(as_text=True)
    if not data: return jsonify({"error":"empty"}),400
    tr = []; ct = "Unknown"
    for line in data.splitlines():
        line = line.strip()
        if not line or line.startswith("#EXTM3U"): continue
        if line.startswith("#EXTINF:"):
            p = line.split(",",1); ct = p[1].strip() if len(p)>1 else "Unknown"; continue
        if line.startswith("#"): continue
        if line: tr.append({"link":line,"title":ct}); ct="Unknown"
    with state_lock:
        app_state["queue"].extend(tr)
        if app_state["status"]=="stopped" and len(app_state["queue"])>0: app_state["current_index"]=0
    return jsonify({"status":"ok","imported":len(tr)})

@app.route('/control/balance')
def set_balance():
    try: l=float(request.args.get('l',1.0)); r=float(request.args.get('r',1.0))
    except: l=1.0; r=1.0
    if l>=0.99 and r>=0.99: af_state["balance"]=""
    else: af_state["balance"]=f"lavfi=[pan=stereo|c0={l:.2f}*c0|c1={r:.2f}*c1]"
    update_mpv_filters()
    return jsonify({"status":"ok","L":l,"R":r})

@app.route('/library/scan')
def scan_library():
    if lib_mgr:
        p = "/root/music"
        if os.path.exists("default_path.txt"):
            try: p = open("default_path.txt").read().strip()
            except: pass
        lib_mgr.scan_directory(p)
        return jsonify({"status":"started","path":p})
    return jsonify({"status":"disabled"})

@app.route('/library/status')
def library_status():
    if lib_mgr: return jsonify(lib_mgr.get_scan_status())
    return jsonify({"status":"disabled"})

@app.route('/library/tracks')
def library_tracks():
    if not lib_mgr: return jsonify([])
    sm = request.args.get('sort','title')
    tr = lib_mgr.get_all_tracks(sm)
    return jsonify([{'name':t['title'],'path':t['path'],'type':'file','artist':t['artist'],'album':t['album'],'meta':f"{t['artist']} - {t['album']}"} for t in tr])

@app.route('/library/search_db')
def search_db():
    if not lib_mgr: return jsonify([])
    q = request.args.get('q','')
    if not q: return jsonify([])
    return jsonify(lib_mgr.search_tracks(q))

@app.route('/get_playlist')
def get_playlist():
    if os.path.exists(PLAYLIST_FILE):
        try: return jsonify(json.load(open(PLAYLIST_FILE)))
        except: pass
    return jsonify([])

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files: return jsonify({"error":"no file"}),400
    f = request.files['file']
    if not f.filename: return jsonify({"error":"no filename"}),400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in AUDIO_EXTS: return jsonify({"error":"unsupported format"}),400
    # Generate unique filename
    uid = str(uuid.uuid4())[:8]
    safe_name = f"{uid}_{f.filename}"
    save_path = os.path.join(UPLOAD_DIR, safe_name)
    f.save(save_path)
    logger.info(f"Uploaded: {safe_name}")
    return jsonify({"status":"ok","filename":safe_name,"path":save_path})

@app.route('/uploads')
def list_uploads():
    files = []
    if os.path.exists(UPLOAD_DIR):
        for fn in sorted(os.listdir(UPLOAD_DIR), key=lambda x: os.path.getmtime(os.path.join(UPLOAD_DIR, x)), reverse=True):
            fp = os.path.join(UPLOAD_DIR, fn)
            if os.path.isfile(fp) and fn.lower().endswith(AUDIO_EXTS):
                files.append({"name":fn, "path":fp, "size":os.path.getsize(fp)})
    return jsonify(files)

@app.route('/save_playlist', methods=['POST'])
def save_playlist():
    try:
        json.dump(request.json, open(PLAYLIST_FILE,'w'))
        return jsonify({"status":"ok"})
    except: return jsonify({"error":"failed"}),500

if __name__ == '__main__':
    subprocess.run("pgrep bluealsa || bluealsa -p a2dp-source -p a2dp-sink &", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    app.run(host=OWRTMB_HOST, port=OWRTMB_PORT, debug=False)