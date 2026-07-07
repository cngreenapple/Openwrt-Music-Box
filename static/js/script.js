// OwrtBox Player - COREv5 (SYNC FIXED)
let browserAudio = null, isSeeking = false, currentLyricIndex = -1;
let lastFrameTime = performance.now(), globalTime = 0, isPlaying = false, totalDuration = 0;
let activeKnob = null, activeKnobRect = null, volTimer = null, eqTimer = null, balTimeout = null;
let lyricsData = [], lyricsType = '', lastLyricsTitle = '', isMuted = false;

let settings;
try { settings = JSON.parse(localStorage.getItem('owrtmb_set')) || getDefaults(); }
catch(e) { settings = getDefaults(); }

let systemState = { powerMode: localStorage.getItem('owrtmb_power') || 'portable', playMode: localStorage.getItem('owrtmb_playmode') || 'server' };

function getDefaults() { return { f1:0,f2:0,f3:0,f4:0,f5:0,f6:0,f7:0,f8:0,f9:0,f10:0, vol:50, active_preset:'Normal' }; }

// ====== INIT ======
window.onload = () => {
    browserAudio = document.getElementById('browser-audio');
    if(browserAudio) {
        browserAudio.addEventListener('timeupdate', onBrowserTime);
        browserAudio.addEventListener('ended', onBrowserEnd);
        browserAudio.addEventListener('loadedmetadata', () => { totalDuration = browserAudio.duration; });
    }

    updateUI(); setupKnobs(); checkBitPerfect(); checkCrossfeed(); initPath();
    initVol(); initKeyboard();

    document.getElementById('mode-' + systemState.playMode).classList.add('active');
    if(systemState.playMode === 'browser') document.getElementById('mode-device').classList.remove('active');

    const pb = document.getElementById('pb');
    if(pb) {
        pb.addEventListener('mousedown', () => isSeeking = true);
        pb.addEventListener('touchstart', () => isSeeking = true, {passive:true});
        pb.addEventListener('change', (e) => {
            isSeeking = false; const p = parseFloat(e.target.value);
            globalTime = (p / 100) * totalDuration;
            if(systemState.playMode === 'browser' && browserAudio) browserAudio.currentTime = globalTime;
            else fetch('/control/seek?val=' + p);
        });
    }

    if(localStorage.getItem('owrtmb_theme') === 'light') document.body.classList.add('light');
    if(localStorage.getItem('owrtmb_muted') === 'true') { isMuted = true; updateMuteBtn(); }

    // Balance slider
    const bs = document.getElementById('balanceSlider');
    if(bs) bs.addEventListener('input', () => updateBalance(parseInt(bs.value)));

    // Volume SLIDER (single control — knob volume disabled in HTML)
    const vs = document.getElementById('vol-slider');
    if(vs) {
        vs.value = settings.vol || 50;
        document.getElementById('vol-val').textContent = settings.vol || 50;
        vs.addEventListener('input', () => {
            const v = parseInt(vs.value);
            settings.vol = v; localStorage.setItem('owrtmb_set', JSON.stringify(settings));
            document.getElementById('vol-val').textContent = v;
            if(systemState.playMode === 'browser' && browserAudio) browserAudio.volume = v / 100;
            else fetch('/control/volume?val=' + v);
        });
    }

    startLoop();
    setInterval(pollStatus, 1000);
};

// ====== KEYBOARD ======
function initKeyboard() {
    document.addEventListener('keydown', (e) => {
        if(e.target.tagName === 'INPUT') return;
        switch(e.code) {
            case 'Space': e.preventDefault(); togglePlay(); break;
            case 'ArrowLeft': ctl('prev'); break;
            case 'ArrowRight': ctl('next'); break;
            case 'ArrowUp': changeVol(5); break;
            case 'ArrowDown': changeVol(-5); break;
            case 'KeyM': toggleMute(); break;
            case 'KeyS': ctl('shuffle'); break;
        }
    });
}
function changeVol(delta) {
    const v = Math.max(0, Math.min(100, (settings.vol || 0) + delta));
    settings.vol = v; localStorage.setItem('owrtmb_set', JSON.stringify(settings));
    document.getElementById('vol-slider').value = v;
    document.getElementById('vol-val').textContent = v;
    fetch('/control/volume?val=' + v);
}

// ====== MUTE ======
function toggleMute() {
    isMuted = !isMuted;
    localStorage.setItem('owrtmb_muted', isMuted ? 'true' : 'false');
    updateMuteBtn();
    fetch('/control/volume?val=' + (isMuted ? 0 : (settings.vol || 50)));
    if(browserAudio) browserAudio.volume = isMuted ? 0 : (settings.vol || 50) / 100;
}
function updateMuteBtn() {
    const btn = document.getElementById('btn-mute');
    if(!btn) return;
    btn.innerHTML = isMuted ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
    btn.classList.toggle('active', isMuted);
}

// ====== RADIO ======
function playRadio(url) {
    if(!url) return; tg('radio');
    if(browserAudio) {
        browserAudio.src = url;
        browserAudio.volume = (settings.vol || 50) / 100;
        browserAudio.play().catch(() => {});
        document.body.classList.add('playing'); isPlaying = true; updatePlayBtn();
        setText('tit', 'Radio Stream'); setText('art', url.substring(0, 40) + '...'); setText('tech-specs', 'STREAMING');
    }
}

// ====== LOOP ======
function startLoop() {
    const loop = (now) => {
        const dt = (now - lastFrameTime) / 1000; lastFrameTime = now;
        if(isPlaying && !isSeeking) { globalTime += dt; syncLyrics(globalTime); updatePbUI(); }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}
function updatePbUI() {
    if(!isSeeking && totalDuration > 0) {
        const pb = document.getElementById('pb');
        if(pb) { pb.value = (globalTime / totalDuration) * 100; setText('t-cur', fmtTime(globalTime)); }
    }
}

// ====== BROWSER ======
function onBrowserTime() {
    if(browserAudio && !isSeeking) {
        globalTime = browserAudio.currentTime; totalDuration = browserAudio.duration || 0;
        const pb = document.getElementById('pb');
        if(pb && totalDuration > 0) pb.value = (globalTime / totalDuration) * 100;
        setText('t-cur', fmtTime(globalTime)); setText('t-tot', fmtTime(totalDuration));
    }
}
function onBrowserEnd() { if(systemState.playMode === 'browser') nextBrowserTrack(); }
function nextBrowserTrack() {
    fetch('/play/next_browser').then(r => r.json()).then(d => {
        if(d.index >= 0) playBrowserTrack(d.link, d.title);
        else { isPlaying = false; updatePlayBtn(); document.body.classList.remove('playing'); }
    });
}
function playBrowserTrack(url, title) {
    if(!browserAudio) return;
    setText('tit', title || 'Unknown'); document.body.classList.add('playing'); isPlaying = true; updatePlayBtn();
    browserAudio.src = '/stream?path=' + encodeURIComponent(url);
    browserAudio.volume = (settings.vol || 50) / 100;
    browserAudio.play().catch(() => {});
    fetch('/play/current').then(r => r.json()).then(d => { if(d.thumb) document.getElementById('cover-img').src = d.thumb; });
}

// ====== PLAY ======
function togglePlay() {
    if(systemState.playMode === 'browser') {
        if(isPlaying) { browserAudio.pause(); isPlaying = false; }
        else { fetch('/play/current').then(r => r.json()).then(d => { if(d.index >= 0 && d.link) playBrowserTrack(d.link, d.title); }); }
        updatePlayBtn(); document.body.classList.toggle('playing', isPlaying);
    } else {
        fetch('/control/pause').then(() => {
            isPlaying = !isPlaying; updatePlayBtn(); document.body.classList.toggle('playing', isPlaying);
        });
    }
}
function updatePlayBtn() { const btn = document.getElementById('pi'); if(btn) btn.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play'; }

// ====== MODE ======
function togglePlayMode() {
    const newMode = systemState.playMode === 'server' ? 'browser' : 'server';
    systemState.playMode = newMode; localStorage.setItem('owrtmb_playmode', newMode);
    document.getElementById('mode-device').classList.toggle('active', newMode === 'server');
    document.getElementById('mode-browser').classList.toggle('active', newMode === 'browser');
    fetch('/play/mode?mode=' + newMode);
    if(newMode === 'browser' && browserAudio) browserAudio.pause();
    showToast('Mode: ' + (newMode === 'server' ? 'Device (MPV)' : 'Browser'));
}

// ====== KNOBS (EQ only — volume knob disabled) ======
function setupKnobs() {
    document.querySelectorAll('.knob.sm').forEach(k => {
        k.addEventListener('mousedown', startDrag);
        k.addEventListener('touchstart', startDrag, {passive:false});
    });
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('touchmove', onDrag, {passive:false});
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);
}
function startDrag(e) { activeKnob = e.currentTarget; activeKnobRect = activeKnob.getBoundingClientRect(); e.preventDefault(); }
function onDrag(e) {
    if(!activeKnob || !activeKnobRect) return;
    const type = activeKnob.dataset.type;
    const cx = activeKnobRect.left + activeKnobRect.width / 2, cy = activeKnobRect.top + activeKnobRect.height / 2;
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - cx, y = (e.touches ? e.touches[0].clientY : e.clientY) - cy;
    let deg = Math.atan2(y, x) * (180 / Math.PI) + 90; if(deg < 0) deg += 360;
    if(type === 'vol') return; // Volume knob disabled — use slider
    let p = 0; if(deg >= 210) p = (deg - 210) / 300; else if(deg <= 150) p = (150 + deg) / 300; else p = (Math.abs(deg - 210) < Math.abs(deg - 150)) ? 0 : 1;
    let v = Math.round((p * 24) - 12);
    if(settings[type] !== v) { settings[type] = v; updateUI(); sendEq(); }
}
function stopDrag() { activeKnob = null; activeKnobRect = null; }
function updateUI() {
    document.querySelectorAll('.knob.sm').forEach(el => { const t = el.dataset.type; if(!t || t === 'vol') return; const val = settings[t] || 0; const deg = ((val + 12) / 24) * 270 - 135; el.style.transform = 'rotate(' + deg + 'deg)'; });
    localStorage.setItem('owrtmb_set', JSON.stringify(settings));
}
function sendEq() { if(eqTimer) clearTimeout(eqTimer); eqTimer = setTimeout(() => { let q = []; for(let i = 1; i <= 10; i++) q.push('f' + i + '=' + (settings['f' + i] || 0)); fetch('/control/eq?' + q.join('&')); }, 100); }

// ====== CONTROLS ======
function ctl(action) {
    if(action === 'pause') togglePlay();
    else if(action === 'prev') {
        if(systemState.playMode === 'browser') { if(globalTime > 3) { globalTime = 0; if(browserAudio) browserAudio.currentTime = 0; } else fetch('/control/prev'); }
        else fetch('/control/prev');
    } else if(action === 'next') { if(systemState.playMode === 'browser') nextBrowserTrack(); else fetch('/control/next'); }
    else if(action === 'shuffle') fetch('/control/shuffle').then(() => showToast('Shuffled'));
    else if(action === 'stop') { if(browserAudio) { browserAudio.pause(); browserAudio.src = ''; } fetch('/control/stop'); }
    if(['shuffle', 'prev', 'next'].includes(action)) setTimeout(loadQueue, 500);
}

// ====== SEARCH ======
function searchYt(e) {
    if(e) e.preventDefault();
    const q = document.getElementById('searchInput').value; if(!q) return;
    const popup = document.getElementById('search-popup'); popup.classList.add('show');
    const c = document.getElementById('popup-content'); c.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">Searching...</div>';
    fetch('/search?q=' + encodeURIComponent(q)).then(r => r.json()).then(data => {
        c.innerHTML = ''; if(!data.length) { c.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">No results</div>'; return; }
        data.forEach(v => {
            const row = document.createElement('div'); row.className = 'lib-item';
            const img = document.createElement('img'); img.src = v.thumb; img.style.cssText = 'width:44px;height:33px;border-radius:5px;object-fit:cover;flex-shrink:0;';
            const info = document.createElement('div'); info.className = 'lib-info';
            const t = document.createElement('div'); t.className = 'lib-name'; t.textContent = v.title;
            const a = document.createElement('div'); a.className = 'lib-type'; a.textContent = v.artist + ' • ' + v.duration;
            info.appendChild(t); info.appendChild(a); row.appendChild(img); row.appendChild(info);
            row.onclick = () => { playSong(v.link, 'play_now', v.title); closeSearch(); };
            c.appendChild(row);
        });
    });
}
function closeSearch() { document.getElementById('search-popup').classList.remove('show'); }

function playSong(url, mode = 'play_now', title = '') {
    fetch(`/play?url=${encodeURIComponent(url)}&mode=${mode}&title=${encodeURIComponent(title)}`).then(r => r.json()).then(d => {
        if(mode === 'play_now') {
            document.body.classList.add('playing'); showToast('▶ ' + (title || 'Track'));
            if(systemState.playMode === 'browser') {
                if(url.includes('youtube') || url.includes('youtu.be')) {
                    fetch('/youtube_audio?url=' + encodeURIComponent(url)).then(r => r.json()).then(yt => {
                        if(yt.audio_url) {
                            setText('tit', yt.title || title);
                            if(yt.thumbnail) document.getElementById('cover-img').src = yt.thumbnail;
                            if(browserAudio) {
                                browserAudio.src = '/youtube_proxy?url=' + encodeURIComponent(url);
                                browserAudio.volume = (settings.vol || 50) / 100;
                                browserAudio.play().catch(() => {}); isPlaying = true; updatePlayBtn();
                            }
                        }
                    }).catch(() => {});
                } else { setTimeout(() => fetch('/play/current').then(r => r.json()).then(p => { if(p.link) playBrowserTrack(p.link, p.title); }), 300); }
            } else { isPlaying = true; updatePlayBtn(); }
        } else showToast('+ Queue (' + d.queue_len + ')');
    });
}

// ====== STATUS POLL ======
function pollStatus() {
    fetch('/status').then(r => r.json()).then(d => {
        // Always update metadata
        setText('tit', d.title || 'Ready');
        setText('art', d.artist || 'OwrtBox');
        setText('tech-specs', d.tech_info || 'AWAITING SIGNAL');

        // SYNC VOLUME SLIDER from server (for server mode)
        const vs = document.getElementById('vol-slider');
        if(vs && d.volume !== undefined) {
            const sv = parseInt(d.volume);
            if(!isMuted && vs.value != sv) {
                vs.value = sv;
                document.getElementById('vol-val').textContent = sv;
                settings.vol = sv;
            }
        }

        // SYNC seekbar
        if(d.current_time !== undefined && Math.abs(globalTime - d.current_time) > 0.5) {
            globalTime = d.current_time;
        }
        if(d.total_time) totalDuration = d.total_time;
        setText('t-tot', fmtTime(totalDuration));

        // Badges
        ['genre', 'year'].forEach(id => {
            const el = document.getElementById(id);
            if(el) { el.textContent = d[id] || ''; el.style.display = d[id] ? 'inline-flex' : 'none'; }
        });

        // SYNC play/pause state (server mode only)
        if(systemState.playMode !== 'browser') {
            if(d.status === 'playing' && !isPlaying) {
                isPlaying = true; updatePlayBtn();
                document.body.classList.add('playing');
                document.getElementById('cover-img').classList.add('spin');
            } else if(d.status !== 'playing' && isPlaying) {
                isPlaying = false; updatePlayBtn();
                document.body.classList.remove('playing');
                document.getElementById('cover-img').classList.remove('spin');
            }
        }

        // Cover art
        const ci = document.getElementById('cover-img');
        if(ci && d.thumb && ci.src !== d.thumb) ci.src = d.thumb;
        else if(ci && !d.thumb && !ci.src.includes('default.png')) ci.src = '/static/img/default.png';
    }).catch(() => {});
}

// ====== UTILS ======
function setText(id, t) { const el = document.getElementById(id); if(el) el.textContent = t; }
function fmtTime(s) { if(!s || isNaN(s)) return '0:00'; let m = Math.floor(s / 60); let sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' + sec : sec); }
function showToast(msg) {
    let box = document.getElementById('toast-box'); if(!box) { box = document.createElement('div'); box.id = 'toast-box'; document.body.appendChild(box); }
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    box.appendChild(el); setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2000);
}
function tg(id) {
    const el = document.getElementById(id); if(!el) return;
    const isAct = el.classList.contains('active') || el.classList.contains('show');
    if(isAct) { el.classList.remove('active', 'show'); if(el.style.display) el.style.display = 'none'; }
    else { el.style.display = 'flex'; void el.offsetWidth; el.classList.add('active'); if(id === 'pm') initPath(); if(id === 'pr-om') initPresets(); }
}
function toggleQuickMenu() {
    const m = document.getElementById('quick-menu'); const b = document.getElementById('btn-menu'); if(!m) return;
    if(m.classList.contains('active')) { m.classList.remove('active'); b.classList.remove('active'); }
    else { m.classList.add('active'); b.classList.add('active'); setTimeout(() => { const c = (e) => { if(!m.contains(e.target) && !b.contains(e.target)) { m.classList.remove('active'); b.classList.remove('active'); document.removeEventListener('click', c); } }; document.addEventListener('click', c); }, 100); }
}
function toggleEq() { document.getElementById('eq-section').classList.toggle('collapsed'); }
function toggleTheme() { document.body.classList.toggle('light'); localStorage.setItem('owrtmb_theme', document.body.classList.contains('light') ? 'light' : 'dark'); }

// ====== LYRICS ======
function toggleLyrics() { tg('lym'); setTimeout(() => { if(document.getElementById('lym').classList.contains('active')) fetchLyrics(); }, 100); }
function fetchLyrics() {
    const c = document.getElementById('lyrics-container'); const t = document.getElementById('tit').innerText;
    c.innerHTML = '<div style="margin-top:20px;color:#888;">Searching...</div>';
    if(t === 'Ready') { c.innerHTML = '<div style="margin-top:50px;color:#666;">Play music</div>'; return; }
    fetch('/get_lyrics').then(r => r.json()).then(d => {
        lastLyricsTitle = t; lyricsData = [];
        if(d.error) { c.innerHTML = '<div style="margin-top:50px;color:#888;">Not found</div>'; return; }
        lyricsType = d.type;
        if(d.type === 'synced') { parseLRC(d.lyrics); renderLyrics(); syncLyrics(globalTime); }
        else { const div = document.createElement('div'); div.style.cssText = 'white-space:pre-wrap;line-height:1.8;color:#eee;font-size:0.95rem;padding:20px 10px 100px;'; div.innerText = d.lyrics; c.innerHTML = ''; c.appendChild(div); }
    }).catch(() => { c.innerHTML = '<div style="margin-top:50px;color:red;">Error</div>'; });
}
function parseLRC(t) { lyricsData = []; t.split('\n').forEach(line => { const m = line.match(/^\[(\d{2}):(\d{2}\.\d{2})\](.*)/); if(m) { const text = m[3].trim(); if(text) lyricsData.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text }); } }); }
function renderLyrics() { const c = document.getElementById('lyrics-container'); c.innerHTML = ''; currentLyricIndex = -1; lyricsData.forEach((l, i) => { const d = document.createElement('div'); d.className = 'lyric-line'; d.id = 'line-' + i; d.innerText = l.text; d.onclick = () => { fetch('/control/seek?val=' + ((l.time / totalDuration) * 100)); globalTime = l.time; }; c.appendChild(d); }); }
function syncLyrics(t) { if(!document.getElementById('lym').classList.contains('active') || lyricsType !== 'synced') return; let idx = -1; for(let i = lyricsData.length - 1; i >= 0; i--) { if(t >= lyricsData[i].time) { idx = i; break } } if(idx !== currentLyricIndex) { const prev = document.getElementById('line-' + currentLyricIndex); if(prev) prev.classList.remove('active'); currentLyricIndex = idx; const act = document.getElementById('line-' + idx); if(act) { act.classList.add('active'); const cont = document.getElementById('lyrics-container'); cont.scrollTo({ top: act.offsetTop - cont.clientHeight / 2 + act.offsetHeight / 2, behavior: 'smooth' }); } } }

// ====== BALANCE ======
function updateBalance(val) { let l = 1.0, r = 1.0; if(val < 0) r = 1 - (Math.abs(val) / 100); else if(val > 0) l = 1 - (val / 100); if(balTimeout) clearTimeout(balTimeout); balTimeout = setTimeout(() => fetch('/control/balance?l=' + l.toFixed(2) + '&r=' + r.toFixed(2)), 100); }

// ====== OUTPUT ======
function manualOut(t) { fetch('/control/output?mode=' + t); showToast('Output: ' + t.toUpperCase()); tg('om'); }
function openBt() { const p = document.getElementById('bt-panel'); if(p.style.display === 'none') p.style.display = 'block'; else manualOut('bluetooth'); }
function scanBt() { const l = document.getElementById('bt-list'); l.innerHTML = '<div style="color:#888;padding:4px;">Scanning...</div>'; fetch('/bt/scan').then(r => r.json()).then(d => { l.innerHTML = ''; if(!d.length) { l.innerHTML = '<div style="color:#666;font-size:0.7rem;">No devices</div>'; return; } d.forEach(dev => { const r = document.createElement('div'); r.style.cssText = 'padding:6px 0;display:flex;justify-content:space-between;cursor:pointer;font-size:0.7rem;border-bottom:1px solid rgba(255,255,255,0.04);'; r.innerHTML = '<span>' + dev.name + '</span><small style="color:#888;">' + dev.mac + '</small>'; r.onclick = () => { fetch('/bt/connect?mac=' + dev.mac).then(r => r.json()).then(d2 => { if(d2.status === 'ok') showToast('BT: ' + d2.name); }) }; l.appendChild(r); }); }); }

// ====== CROSSFEED & BITPERFECT ======
function checkBitPerfect() { fetch('/get_bitperfect').then(r => r.json()).then(d => { const dot = document.getElementById('bp-dot'); if(dot) dot.style.display = d.active ? 'block' : 'none'; const btn = document.getElementById('btn-bp'); if(btn) btn.classList.toggle('active', d.active); }); }
function toggleBitPerfect() { fetch('/control/bitperfect').then(r => r.json()).then(d => { checkBitPerfect(); showToast(d.bitperfect ? 'Bit Perfect ON' : 'Bit Perfect OFF'); }); }
function checkCrossfeed() { fetch('/get_crossfeed').then(r => r.json()).then(d => { const dot = document.getElementById('xf-dot'); if(dot) dot.style.display = d.active ? 'block' : 'none'; const btn = document.getElementById('btn-xf'); if(btn) btn.classList.toggle('active', d.active); }); }
function toggleCrossfeed() { const btn = document.getElementById('btn-xf'); const state = btn.classList.contains('active') ? 'off' : 'on'; fetch('/control/crossfeed?state=' + state).then(() => { checkCrossfeed(); showToast(state === 'on' ? 'Crossfeed ON' : 'Crossfeed OFF'); }); }

// ====== LIBRARY ======
function initPath() { fetch('/library/tracks').then(r => r.json()).then(t => { if(t && t.length) loadLibraryDB(); }).catch(() => {}); }
function openLibrary() { tg('pm'); }
function switchTab(t) {
    document.querySelectorAll('#pm .tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + t).classList.add('active');
    document.querySelectorAll('#pm .tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('content-' + t).classList.add('active');
    if(t === 'files') loadLocalFiles('/root/music');
    if(t === 'saved') loadSavedPlaylists();
    if(t === 'queue') loadQueue();
}
async function loadLocalFiles(path) {
    const l = document.getElementById('lib-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#888;"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
        const items = await (await fetch('/get_files?path=' + encodeURIComponent(path))).json();
        l.innerHTML = ''; if(items.length === 0) { l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">Empty</div>'; return; }
        items.forEach(item => {
            const row = document.createElement('div'); row.className = 'lib-item';
            const icon = document.createElement('div'); icon.className = 'lib-icon ' + (item.type === 'dir' ? 'folder' : 'file');
            icon.innerHTML = '<i class="fa-solid fa-' + (item.type === 'dir' ? 'folder' : 'music') + '"></i>';
            const info = document.createElement('div'); info.className = 'lib-info';
            const name = document.createElement('div'); name.className = 'lib-name'; name.textContent = item.name;
            info.appendChild(name); row.appendChild(icon); row.appendChild(info);
            row.onclick = () => { if(item.type === 'dir') loadLocalFiles(item.path); else { playSong(item.path, 'play_now', item.name); tg('pm'); } };
            l.appendChild(row);
        });
    } catch(e) { l.innerHTML = '<div style="text-align:center;color:red;">Error</div>'; }
}
function uploadFiles(e) {
    const files = e.target.files; if(!files.length) return;
    const status = document.getElementById('scan-status');
    Array.from(files).forEach((file, i) => {
        status.textContent = 'Uploading ' + (i + 1) + '/' + files.length + '...';
        const form = new FormData(); form.append('file', file);
        fetch('/upload', { method: 'POST', body: form }).then(r => r.json()).then(d => {
            if(d.status === 'ok') { showToast('Uploaded: ' + file.name); if(i === files.length - 1) { status.textContent = 'Upload complete'; loadLocalFiles('/root/uploads'); } }
            else showToast('Upload failed: ' + file.name);
        }).catch(() => showToast('Upload error: ' + file.name));
    });
}
function scanLibrary() {
    const s = document.getElementById('scan-status'); s.textContent = 'Scanning...';
    fetch('/library/scan').then(() => {
        const iv = setInterval(() => {
            fetch('/library/status').then(r => r.json()).then(d => {
                if(d.scanning) s.textContent = d.progress + '%';
                else { clearInterval(iv); s.textContent = d.total + ' Tracks'; showToast('Library Updated!'); loadLibraryDB(); }
            });
        }, 1000);
    });
}
async function loadLibraryDB() {
    const l = document.getElementById('lib-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';
    try {
        const tracks = await (await fetch('/library/tracks')).json();
        l.innerHTML = ''; if(!tracks.length) { l.innerHTML = '<div style="padding:30px;text-align:center;color:#666;">Empty</div>'; return; }
        tracks.forEach(t => {
            const r = document.createElement('div'); r.className = 'lib-item'; r.dataset.meta = (t.name + ' ' + t.artist + ' ' + t.album).toLowerCase();
            const i = document.createElement('div'); i.className = 'lib-icon file'; i.innerHTML = '<i class="fa-solid fa-music"></i>';
            const info = document.createElement('div'); info.className = 'lib-info';
            const n = document.createElement('div'); n.className = 'lib-name'; n.textContent = t.name;
            const m = document.createElement('div'); m.className = 'lib-type'; m.textContent = t.meta;
            info.appendChild(n); info.appendChild(m); r.appendChild(i); r.appendChild(info);
            r.onclick = () => playSong(t.path, 'play_now', t.name);
            l.appendChild(r);
        });
    } catch(e) { l.innerHTML = '<div style="text-align:center;color:red;">Error</div>'; }
}
function filterLibraryLocal(q) { const ql = q.toLowerCase(); document.querySelectorAll('#lib-list .lib-item').forEach(r => { r.style.display = (r.dataset.meta || '').includes(ql) ? 'flex' : 'none'; }); }

// ====== MINI QUEUE ======
function updateMiniQueue() {
    const mq = document.getElementById('mini-queue'); const mql = document.getElementById('mini-queue-list');
    if(!mq || !mql) return;
    fetch('/queue/list').then(r => r.json()).then(d => {
        if(d.queue.length > 1 && d.current_index >= 0) {
            mq.style.display = 'block'; mql.innerHTML = '';
            const start = d.current_index + 1;
            for(let i = start; i < Math.min(start + 3, d.queue.length); i++) {
                const item = d.queue[i]; const div = document.createElement('div');
                div.style.cssText = 'font-size:0.6rem;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;';
                div.textContent = (i + 1) + '. ' + item.title;
                div.onclick = () => { fetch('/control/jump?index=' + i).then(() => showToast('Jump: ' + item.title)); };
                mql.appendChild(div);
            }
            if(start + 3 < d.queue.length) { const more = document.createElement('div'); more.style.cssText = 'font-size:0.55rem;color:#555;'; more.textContent = '+' + (d.queue.length - start - 3) + ' more'; mql.appendChild(more); }
        } else { mq.style.display = 'none'; }
    }).catch(() => {});
}

// ====== QUEUE ======
async function loadQueue() {
    const l = document.getElementById('queue-list'); l.innerHTML = '';
    try {
        const d = await (await fetch('/queue/list')).json();
        if(!d.queue.length) { l.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">Empty</div>'; return; }
        d.queue.forEach((item, i) => {
            const r = document.createElement('div'); r.className = 'queue-item' + (i === d.current_index ? ' now' : '');
            const info = document.createElement('div'); info.className = 'lib-info';
            const n = document.createElement('div'); n.className = 'lib-name'; n.textContent = item.title;
            if(i === d.current_index) n.style.color = 'var(--accent)';
            info.appendChild(n); r.appendChild(info);
            r.onclick = () => { fetch('/control/jump?index=' + i).then(() => showToast('Jump: ' + item.title)); };
            l.appendChild(r);
        });
    } catch(e) {}
}
function clearQueue() { fetch('/queue/clear').then(() => loadQueue()); }

// ====== PRESETS ======
function initPresets() {
    const c = document.getElementById('preset-container'); if(!c) return; c.innerHTML = '';
    const list = ["Normal", "Bass", "Rock", "Pop", "Jazz", "Vocal", "Metal", "Classic", "Dance", "Party"];
    list.forEach(n => {
        const b = document.createElement('button'); b.className = 'preset-btn' + (settings.active_preset === n ? ' active' : ''); b.textContent = n;
        b.onclick = () => {
            settings.active_preset = n;
            fetch('/control/preset?name=' + n).then(r => r.json()).then(d => { for(let k in d) settings[k] = d[k]; updateUI(); tg('pr-om'); showToast('EQ: ' + n); });
        };
        c.appendChild(b);
    });
}
function setTimer(m) { fetch('/system/timer?min=' + m).then(() => showToast(m > 0 ? 'Sleep ' + m + 'm' : 'Timer Off')); }

// ====== PLAYLIST ======
async function addPl() {
    const name = document.getElementById('pl-name').value.trim(); const url = document.getElementById('pl-url').value.trim();
    if(!name || !url) return showToast('Name & URL required');
    const list = await (await fetch('/get_playlist')).json();
    list.push({ title: name, link: url, added_at: Date.now() });
    await fetch('/save_playlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) });
    showToast('Saved!'); loadSavedPlaylists();
}
function loadSavedPlaylists() {
    const l = document.getElementById('pl-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">Loading...</div>';
    fetch('/get_playlist').then(r => r.json()).then(data => {
        l.innerHTML = ''; if(!data.length) { l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">Empty</div>'; return; }
        data.forEach((item, i) => {
            const r = document.createElement('div'); r.className = 'lib-item';
            const d = document.createElement('div'); d.className = 'lib-icon'; d.style.background = 'rgba(255,0,0,0.1)'; d.style.color = '#ff4444';
            d.innerHTML = '<i class="fa-solid fa-trash"></i>';
            d.onclick = (e) => { e.stopPropagation(); deletePlItem(i); };
            const info = document.createElement('div'); info.className = 'lib-info';
            const n = document.createElement('div'); n.className = 'lib-name'; n.textContent = item.title;
            info.appendChild(n); r.appendChild(d); r.appendChild(info);
            r.onclick = () => playSong(item.link, 'play_now', item.title);
            l.appendChild(r);
        });
    });
}
async function deletePlItem(idx) { const list = await (await fetch('/get_playlist')).json(); list.splice(idx, 1); await fetch('/save_playlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) }); loadSavedPlaylists(); showToast('Deleted'); }
function exportM3U() { window.location.href = '/playlist/export_m3u'; showToast('Exporting...'); }
function importM3U(e) { const file = e.target.files[0]; if(!file) return; const reader = new FileReader(); reader.onload = async(ev) => { const r = await fetch('/playlist/import_m3u', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev.target.result }); const d = await r.json(); if(d.status === 'ok') { showToast('Imported ' + d.imported); loadQueue(); } }; reader.readAsText(file); }