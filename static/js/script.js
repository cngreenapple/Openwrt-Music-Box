// OwrtBox Player - CORE LOGIC v3
let browserAudio = null, isSeeking = false, currentLyricIndex = -1;
let lastFrameTime = performance.now(), globalTime = 0, isPlaying = false, totalDuration = 0;
let volTimer = null, eqTimer = null, balTimeout = null;
let lyricsData = [], lyricsType = '', lastLyricsTitle = '';

let settings;
try { settings = JSON.parse(localStorage.getItem('owrtmb_set')) || getDefaults(); }
catch(e) { settings = getDefaults(); }

let systemState = {
    powerMode: localStorage.getItem('owrtmb_power') || 'portable',
    playMode: localStorage.getItem('owrtmb_playmode') || 'server'
};

function getDefaults() {
    return { f1:0,f2:0,f3:0,f4:0,f5:0,f6:0,f7:0,f8:0,f9:0,f10:0, vol:50, active_preset:'Normal' };
}

// === Init ===
window.onload = () => {
    browserAudio = document.getElementById('browser-audio');
    if(browserAudio) {
        browserAudio.addEventListener('timeupdate', onBrowserTime);
        browserAudio.addEventListener('ended', onBrowserEnd);
        browserAudio.addEventListener('loadedmetadata', () => { totalDuration = browserAudio.duration; });
    }
    updateEQ(); setupEQDrag(); initVol(); initPath();
    document.getElementById('mode-'+systemState.playMode).classList.add('active');
    if(systemState.playMode === 'browser') {
        document.getElementById('mode-device').classList.remove('active');
        document.getElementById('mode-browser').classList.add('active');
    }
    
    const pb = document.getElementById('pb');
    if(pb) {
        pb.addEventListener('mousedown', () => isSeeking = true);
        pb.addEventListener('touchstart', () => isSeeking = true, {passive:true});
        pb.addEventListener('change', (e) => {
            isSeeking = false; const p = parseFloat(e.target.value);
            globalTime = (p/100)*totalDuration;
            if(systemState.playMode === 'browser' && browserAudio) browserAudio.currentTime = globalTime;
            else fetch('/control/seek?val='+p);
        });
        pb.addEventListener('mouseup', () => isSeeking = false);
    }
    
    if(localStorage.getItem('owrtmb_theme') === 'light') document.body.classList.add('light');
    startLoop();
    setInterval(pollStatus, 1000);
    
    const bs = document.getElementById('balanceSlider');
    if(bs) bs.addEventListener('input', () => updateBalance(parseInt(bs.value)));
};

function startLoop() {
    const loop = (now) => {
        const dt = (now - lastFrameTime)/1000; lastFrameTime = now;
        if(isPlaying && !isSeeking) { globalTime += dt; syncLyrics(globalTime); updatePbUI(); }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

function updatePbUI() {
    if(!isSeeking && totalDuration > 0) {
        const pb = document.getElementById('pb');
        if(pb) { pb.value = (globalTime/totalDuration)*100; setText('t-cur', fmtTime(globalTime)); }
    }
}

// === Browser Audio ===
function onBrowserTime() {
    if(browserAudio && !isSeeking) {
        globalTime = browserAudio.currentTime;
        totalDuration = browserAudio.duration || 0;
        const pb = document.getElementById('pb');
        if(pb && totalDuration > 0) pb.value = (globalTime/totalDuration)*100;
        setText('t-cur', fmtTime(globalTime));
        setText('t-tot', fmtTime(totalDuration));
    }
}

function onBrowserEnd() {
    if(systemState.playMode === 'browser') nextBrowserTrack();
}

function nextBrowserTrack() {
    fetch('/play/next_browser').then(r=>r.json()).then(d => {
        if(d.index >= 0) playBrowserTrack(d.link, d.title);
        else { isPlaying = false; updatePlayBtn(); document.body.classList.remove('playing'); }
    });
}

function playBrowserTrack(url, title) {
    if(!browserAudio) return;
    setText('tit', title || 'Unknown');
    document.body.classList.add('playing'); isPlaying = true; updatePlayBtn();
    const streamUrl = '/stream?path=' + encodeURIComponent(url);
    browserAudio.src = streamUrl;
    browserAudio.volume = (settings.vol || 50) / 100;
    browserAudio.play().catch(() => {});
    fetch('/play/current').then(r=>r.json()).then(d => { if(d.thumb) document.getElementById('cover-img').src = d.thumb; });
}

// === Toggle Play ===
function togglePlay() {
    if(systemState.playMode === 'browser') {
        if(isPlaying) { browserAudio.pause(); isPlaying = false; }
        else {
            fetch('/play/current').then(r=>r.json()).then(d => {
                if(d.index >= 0 && d.link) playBrowserTrack(d.link, d.title);
            });
        }
        updatePlayBtn(); document.body.classList.toggle('playing', isPlaying);
    } else {
        fetch('/control/pause').then(() => {
            isPlaying = !isPlaying; updatePlayBtn();
            document.body.classList.toggle('playing', isPlaying);
        });
    }
}

function updatePlayBtn() {
    const btn = document.getElementById('pi');
    if(btn) btn.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
}

// === Play Mode Toggle ===
function togglePlayMode() {
    const newMode = systemState.playMode === 'server' ? 'browser' : 'server';
    systemState.playMode = newMode;
    localStorage.setItem('owrtmb_playmode', newMode);
    document.getElementById('mode-device').classList.toggle('active', newMode === 'server');
    document.getElementById('mode-browser').classList.toggle('active', newMode === 'browser');
    fetch('/play/mode?mode='+newMode);
    if(newMode === 'browser' && browserAudio) browserAudio.pause();
    showToast('Mode: ' + (newMode === 'server' ? 'Device (MPV)' : 'Browser (HTML5)'));
}

// === Volume ===
function initVol() {
    const vs = document.getElementById('vol-slider');
    if(vs) {
        vs.value = settings.vol || 50;
        vs.addEventListener('input', () => {
            const v = parseInt(vs.value); settings.vol = v;
            localStorage.setItem('owrtmb_set', JSON.stringify(settings));
            document.getElementById('vol-val').textContent = v;
            if(systemState.playMode === 'browser' && browserAudio) browserAudio.volume = v/100;
            else fetch('/control/volume?val='+v);
        });
    }
}

// === EQ ===
function setupEQDrag() {
    document.querySelectorAll('.eq-bar-wrap').forEach(w => {
        w.addEventListener('mousedown', (e) => startEQ(e, w));
        w.addEventListener('touchstart', (e) => startEQ(e, w), {passive:false});
    });
}

function startEQ(e, wrap) {
    e.preventDefault();
    const f = parseInt(wrap.dataset.f);
    const track = wrap.querySelector('.eq-track');
    const fill = wrap.querySelector('.eq-fill');
    if(!track) return;
    function move(ev) {
        ev.preventDefault();
        const rect = track.getBoundingClientRect();
        const y = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
        const pct = Math.max(0, Math.min(100, (1 - y/rect.height)*100));
        const val = Math.round((pct/100*24)-12);
        settings['f'+f] = val; fill.style.height = pct+'%';
        localStorage.setItem('owrtmb_set', JSON.stringify(settings)); sendEQ();
    }
    function up() { document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); document.removeEventListener('touchmove',move); document.removeEventListener('touchend',up); }
    document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
    document.addEventListener('touchmove',move,{passive:false}); document.addEventListener('touchend',up);
}

function updateEQ() {
    for(let i=1; i<=10; i++) {
        const pct = (( (settings['f'+i]||0) +12)/24)*100;
        const fill = document.getElementById('eq-f'+i);
        if(fill) fill.style.height = pct+'%';
    }
    document.getElementById('vol-val').textContent = settings.vol;
    localStorage.setItem('owrtmb_set', JSON.stringify(settings));
}

function sendEQ() {
    if(eqTimer) clearTimeout(eqTimer);
    eqTimer = setTimeout(() => {
        let q = [];
        for(let i=1; i<=10; i++) q.push('f'+i+'='+(settings['f'+i]||0));
        fetch('/control/eq?'+q.join('&'));
    }, 150);
}

// === Panel Toggle ===
function togglePanel() {
    document.getElementById('panel-eq').classList.toggle('open');
}

// === Tab Switching ===
function switchTab(tab) {
    document.querySelectorAll('.tabbar-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-'+tab).classList.add('active');
    document.getElementById('page-'+tab).classList.add('active');
    if(tab === 'queue') loadQueue();
    if(tab === 'search') { document.getElementById('searchInput2').focus(); }
}

// === Search ===
function searchYt(e) {
    if(e) e.preventDefault();
    const q = document.getElementById('searchInput').value || document.getElementById('searchInput2').value;
    if(!q) return;
    
    // Show popup
    const popup = document.getElementById('search-popup');
    popup.style.display = 'flex';
    const c = document.getElementById('popup-content');
    c.innerHTML = '<div style="padding:20px;text-align:center;color:#888;"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';
    
    fetch('/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(data => {
        c.innerHTML = '';
        if(!data.length) { c.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">No results</div>'; return; }
        data.forEach(v => {
            const row = document.createElement('div'); row.className = 'search-item';
            const img = document.createElement('img'); img.src = v.thumb;
            const info = document.createElement('div'); info.className = 'info';
            const t = document.createElement('div'); t.className = 'title'; t.textContent = v.title;
            const a = document.createElement('div'); a.className = 'artist'; a.textContent = v.artist+' • '+v.duration;
            info.appendChild(t); info.appendChild(a); row.appendChild(img); row.appendChild(info);
            row.onclick = () => { playSong(v.link, 'play_now', v.title); closeSearch(); };
            c.appendChild(row);
        });
    });
}

function closeSearch() { document.getElementById('search-popup').style.display = 'none'; }

// === Play Song ===
function playSong(url, mode='play_now', title='') {
    fetch(`/play?url=${encodeURIComponent(url)}&mode=${mode}&title=${encodeURIComponent(title)}`)
        .then(r=>r.json()).then(d => {
            if(mode === 'play_now') {
                document.body.classList.add('playing'); showToast('▶ '+(title||'Track'));
                if(systemState.playMode === 'browser' && !url.includes('youtube') && !url.includes('youtu.be')) {
                    setTimeout(() => fetch('/play/current').then(r=>r.json()).then(p => { if(p.link) playBrowserTrack(p.link, p.title); }), 300);
                } else { isPlaying = true; updatePlayBtn(); }
            } else showToast('+ Queue ('+d.queue_len+')');
            if(document.getElementById('tab-queue').classList.contains('active')) loadQueue();
        });
}

// === Controls ===
function ctl(action) {
    if(action === 'pause') togglePlay();
    else if(action === 'prev') {
        if(systemState.playMode === 'browser') {
            if(globalTime > 3 && isPlaying) { globalTime = 0; if(browserAudio) browserAudio.currentTime = 0; }
            else fetch('/control/prev');
        } else fetch('/control/prev');
    } else if(action === 'next') {
        if(systemState.playMode === 'browser') nextBrowserTrack();
        else fetch('/control/next');
    } else if(action === 'shuffle') fetch('/control/shuffle').then(()=>showToast('Shuffled'));
    if(['shuffle','prev','next'].includes(action)) setTimeout(loadQueue, 500);
}

// === Status Poll ===
function pollStatus() {
    fetch('/status').then(r=>r.json()).then(d => {
        if(systemState.playMode !== 'browser') {
            setText('tit', d.title||'Ready'); setText('art', d.artist||'OwrtBox');
            if(Math.abs(globalTime - d.current_time) > 0.5) globalTime = d.current_time;
            totalDuration = d.total_time; setText('t-tot', fmtTime(d.total_time));
            ['genre','year'].forEach(id => {
                const el = document.getElementById(id);
                if(el) { el.textContent = d[id]||''; el.style.display = d[id] ? 'inline-flex' : 'none'; }
            });
            if(d.status === 'playing') {
                if(!isPlaying) { isPlaying = true; updatePlayBtn(); document.body.classList.add('playing'); document.getElementById('cover-img').classList.add('spin'); }
            } else {
                if(isPlaying) { isPlaying = false; updatePlayBtn(); document.body.classList.remove('playing'); document.getElementById('cover-img').classList.remove('spin'); }
            }
        }
        setText('tech-specs', d.tech_info||'AWAITING SIGNAL');
        const ci = document.getElementById('cover-img');
        if(ci && d.thumb && ci.src !== d.thumb) ci.src = d.thumb;
        else if(ci && !d.thumb && !ci.src.includes('default.png')) ci.src = '/static/img/default.png';
    }).catch(()=>{});
}

// === Utils ===
function setText(id, t) { const el = document.getElementById(id); if(el) el.textContent = t; }
function fmtTime(s) { if(!s||isNaN(s)) return '0:00'; let m=Math.floor(s/60); let sec=Math.floor(s%60); return m+':'+(sec<10?'0'+sec:sec); }
function showToast(msg) {
    let box = document.getElementById('toast-box');
    if(!box) { box = document.createElement('div'); box.id='toast-box'; document.body.appendChild(box); }
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity='0'; setTimeout(()=>el.remove(),300); }, 2000);
}

function tg(id) {
    const el = document.getElementById(id);
    if(!el) return;
    const isAct = el.classList.contains('active');
    if(isAct) {
        el.classList.remove('active');
        setTimeout(() => { if(!el.classList.contains('active')) el.style.display = 'none'; }, 300);
    } else {
        el.style.display = 'flex';
        void el.offsetWidth;
        el.classList.add('active');
        if(id === 'pm') { initPath(); document.querySelector('#libtab-files').click(); }
        if(id === 'pr-om') presets();
    }
}

// === Theme ===
function toggleTheme() {
    document.body.classList.toggle('light');
    localStorage.setItem('owrtmb_theme', document.body.classList.contains('light') ? 'light' : 'dark');
}

// === Lyrics ===
function fetchLyrics() {
    const c = document.getElementById('lyrics-container');
    const t = document.getElementById('tit').innerText;
    c.innerHTML = '<div style="margin-top:20px;color:#888;">Searching...</div>';
    if(t === 'Ready') { c.innerHTML = '<div style="margin-top:50px;color:#666;">Play music</div>'; return; }
    fetch('/get_lyrics').then(r=>r.json()).then(d => {
        lastLyricsTitle = t; lyricsData = [];
        if(d.error) { c.innerHTML = '<div style="margin-top:50px;color:#888;">Not found</div>'; return; }
        lyricsType = d.type;
        if(d.type === 'synced') { parseLRC(d.lyrics); renderLyrics(); syncLyrics(globalTime); }
        else {
            c.innerHTML = ''; const div = document.createElement('div');
            div.style.cssText = 'white-space:pre-wrap;line-height:1.8;color:#eee;font-size:1rem;padding:20px 10px 100px;';
            div.innerText = d.lyrics; c.appendChild(div);
        }
    }).catch(() => { c.innerHTML = '<div style="margin-top:50px;color:red;">Error</div>'; });
}

function parseLRC(t) {
    lyricsData = [];
    t.split('\n').forEach(line => {
        const m = line.match(/^\[(\d{2}):(\d{2}\.\d{2})\](.*)/);
        if(m) { const text = m[3].trim(); if(text) lyricsData.push({ time: parseInt(m[1])*60+parseFloat(m[2]), text }); }
    });
}

function renderLyrics() {
    const c = document.getElementById('lyrics-container'); c.innerHTML = ''; currentLyricIndex = -1;
    lyricsData.forEach((l,i) => {
        const d = document.createElement('div'); d.className = 'lyric-line'; d.id='line-'+i; d.innerText = l.text;
        d.onclick = () => { fetch('/control/seek?val='+((l.time/totalDuration)*100)); globalTime = l.time; };
        c.appendChild(d);
    });
}

function syncLyrics(t) {
    if(!document.getElementById('lym').classList.contains('active') || lyricsType !== 'synced') return;
    let idx = -1;
    for(let i=lyricsData.length-1; i>=0; i--) { if(t >= lyricsData[i].time) { idx=i; break; } }
    if(idx !== currentLyricIndex) {
        const prev = document.getElementById('line-'+currentLyricIndex);
        if(prev) prev.classList.remove('active');
        currentLyricIndex = idx;
        const act = document.getElementById('line-'+idx);
        if(act) {
            act.classList.add('active');
            const cont = document.getElementById('lyrics-container');
            cont.scrollTo({ top: act.offsetTop - cont.clientHeight/2 + act.offsetHeight/2, behavior: 'smooth' });
        }
    }
}

// === Balance ===
function updateBalance(val) {
    let l=1.0, r=1.0;
    if(val<0) r=1-(Math.abs(val)/100);
    else if(val>0) l=1-(val/100);
    if(balTimeout) clearTimeout(balTimeout);
    balTimeout = setTimeout(() => fetch('/control/balance?l='+l.toFixed(2)+'&r='+r.toFixed(2)), 100);
}

// === Output ===
function manualOut(t) {
    fetch('/control/output?mode='+t); showToast('Output: '+t.toUpperCase()); tg('om');
}

function openBt() {
    tg('om');
    document.getElementById('bt-section').style.display = 'block';
    scanBt();
}

// === Bluetooth ===
function scanBt() {
    const l = document.getElementById('bt-list'); l.innerHTML = '<div style="color:#888;padding:4px;">Scanning...</div>';
    fetch('/bt/scan').then(r=>r.json()).then(d => {
        l.innerHTML = '';
        if(!d.length) { l.innerHTML = '<div style="color:#666;font-size:0.7rem;">No devices</div>'; return; }
        d.forEach(dev => {
            const r = document.createElement('div'); r.style.cssText = 'padding:6px 0;display:flex;justify-content:space-between;cursor:pointer;font-size:0.75rem;border-bottom:1px solid rgba(255,255,255,0.04);';
            r.innerHTML = '<span>'+dev.name+'</span><small style="color:#888;">'+dev.mac+'</small>';
            r.onclick = () => { fetch('/bt/connect?mac='+dev.mac).then(r=>r.json()).then(d2 => { if(d2.status==='ok') showToast('BT: '+d2.name); }); };
            l.appendChild(r);
        });
    });
}

// === Library ===
function initPath() { fetch('/library/tracks').then(r=>r.json()).then(tracks => { if(tracks && tracks.length) loadLibraryDB(); }).catch(()=>{}); }

function openLibrary() { tg('pm'); }

function libTab(t) {
    document.querySelectorAll('#pm .tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('libtab-'+t).classList.add('active');
    document.getElementById('lib-content-files').style.display = t==='files' ? 'block' : 'none';
    document.getElementById('lib-content-saved').style.display = t==='saved' ? 'block' : 'none';
    if(t==='files') initPath();
    if(t==='saved') loadSavedPlaylists();
}

async function loadLocalFiles(path) {
    const l = document.getElementById('lib-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#888;"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
        const items = await (await fetch('/get_files?path='+encodeURIComponent(path))).json();
        l.innerHTML = '';
        items.forEach(item => {
            const row = document.createElement('div'); row.className = 'lib-item';
            const icon = document.createElement('div');
            icon.className = 'lib-icon ' + (item.type==='dir'?'folder':'file');
            icon.innerHTML = '<i class="fa-solid fa-'+(item.type==='dir'?'folder':'music')+'"></i>';
            const info = document.createElement('div'); info.className = 'lib-info';
            const name = document.createElement('div'); name.className = 'lib-name'; name.textContent = item.name;
            info.appendChild(name); row.appendChild(icon); row.appendChild(info);
            row.onclick = () => { if(item.type==='dir') loadLocalFiles(item.path); else { playSong(item.path,'play_now',item.name); tg('pm'); } };
            l.appendChild(row);
        });
    } catch(e) { l.innerHTML = '<div style="text-align:center;color:red;">Error</div>'; }
}

function scanLibrary() {
    const s = document.getElementById('scan-status'); s.textContent = 'Scanning...';
    fetch('/library/scan').then(() => {
        const iv = setInterval(() => {
            fetch('/library/status').then(r=>r.json()).then(d => {
                if(d.scanning) s.textContent = d.progress+'%';
                else { clearInterval(iv); s.textContent = d.total+' Tracks'; showToast('Library Updated!'); }
            });
        }, 1000);
    });
}

async function loadLibraryDB(sortBy) {
    const l = document.getElementById('lib-list');
    l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';
    try {
        const r = await fetch('/library/tracks'+(sortBy?'?sort='+sortBy:''));
        const tracks = await r.json();
        l.innerHTML = '';
        if(!tracks.length) { l.innerHTML = '<div style="padding:30px;text-align:center;color:#666;">Empty</div>'; return; }
        tracks.forEach(t => {
            const r = document.createElement('div'); r.className = 'lib-item'; r.dataset.meta = (t.name+' '+t.artist+' '+t.album).toLowerCase();
            const i = document.createElement('div'); i.className = 'lib-icon file'; i.innerHTML = '<i class="fa-solid fa-music"></i>';
            const info = document.createElement('div'); info.className = 'lib-info';
            const n = document.createElement('div'); n.className = 'lib-name'; n.textContent = t.name;
            const m = document.createElement('div'); m.className = 'lib-type'; m.textContent = t.meta;
            info.appendChild(n); info.appendChild(m); r.appendChild(i); r.appendChild(info);
            r.onclick = () => playSong(t.path,'play_now',t.name);
            l.appendChild(r);
        });
    } catch(e) { l.innerHTML = '<div style="text-align:center;color:red;">Error</div>'; }
}

function filterLibraryLocal(q) {
    const ql = q.toLowerCase();
    document.querySelectorAll('#lib-list .lib-item').forEach(r => {
        r.style.display = (r.dataset.meta||'').includes(ql) ? 'flex' : 'none';
    });
}

// === Queue ===
async function loadQueue() {
    const l = document.getElementById('queue-list'); l.innerHTML = '';
    try {
        const d = await (await fetch('/queue/list')).json();
        if(!d.queue.length) { l.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">Empty</div>'; return; }
        d.queue.forEach((item,i) => {
            const r = document.createElement('div'); r.className = 'queue-item'+(i===d.current_index?' now':'');
            const info = document.createElement('div'); info.className = 'info';
            const n = document.createElement('div'); n.className = 'title'; n.textContent = item.title;
            info.appendChild(n); r.appendChild(info);
            r.onclick = () => { fetch('/control/jump?index='+i).then(()=>showToast('Jump: '+item.title)); };
            l.appendChild(r);
        });
    } catch(e) {}
}

function clearQueue() { fetch('/queue/clear').then(()=>loadQueue()); }

// === Presets ===
function presets() { tg('pr-om'); }

function initPresets() {
    const c = document.getElementById('preset-container'); if(!c) return; c.innerHTML = '';
    const list = ["Normal","Bass","Rock","Pop","Jazz","Vocal","Metal","Classic"];
    list.forEach(n => {
        const b = document.createElement('button');
        b.className = 'preset-btn' + (settings.active_preset === n ? ' active' : '');
        b.textContent = n;
        b.onclick = () => {
            settings.active_preset = n;
            fetch('/control/preset?name='+n).then(r=>r.json()).then(d => {
                for(let k in d) settings[k] = d[k]; updateEQ(); tg('pr-om');
                document.getElementById('cur-preset-txt').textContent = n;
                showToast('EQ: '+n);
            });
        };
        c.appendChild(b);
    });
}

// === Timer ===
function setTimer(m) { fetch('/system/timer?min='+m).then(()=>showToast(m>0?'Sleep '+m+'m':'Timer Off')); }

// === Playlist ===
async function addPl() {
    const name = document.getElementById('pl-name').value.trim();
    const url = document.getElementById('pl-url').value.trim();
    if(!name||!url) return showToast('Name & URL required');
    const list = await (await fetch('/get_playlist')).json();
    list.push({title:name,link:url,added_at:Date.now()});
    await fetch('/save_playlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(list)});
    showToast('Saved!'); loadSavedPlaylists();
}

function loadSavedPlaylists() {
    const l = document.getElementById('pl-list');
    l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">Loading...</div>';
    fetch('/get_playlist').then(r=>r.json()).then(data => {
        l.innerHTML = '';
        if(!data.length) { l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">Empty</div>'; return; }
        data.forEach((item,i) => {
            const r = document.createElement('div'); r.className = 'lib-item';
            const d = document.createElement('div'); d.className = 'lib-icon'; d.style.background='rgba(255,0,0,0.1)'; d.style.color='#ff4444';
            d.innerHTML = '<i class="fa-solid fa-trash"></i>';
            d.onclick = (e) => { e.stopPropagation(); deletePlItem(i); };
            const info = document.createElement('div'); info.className = 'lib-info';
            const n = document.createElement('div'); n.className = 'lib-name'; n.textContent = item.title;
            info.appendChild(n); r.appendChild(d); r.appendChild(info);
            r.onclick = () => playSong(item.link,'play_now',item.title);
            l.appendChild(r);
        });
    });
}

async function deletePlItem(idx) {
    const list = await (await fetch('/get_playlist')).json();
    list.splice(idx,1);
    await fetch('/save_playlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(list)});
    loadSavedPlaylists(); showToast('Deleted');
}

function exportM3U() { window.location.href = '/playlist/export_m3u'; showToast('Exporting...'); }

function importM3U(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        const r = await fetch('/playlist/import_m3u',{method:'POST',headers:{'Content-Type':'text/plain'},body:ev.target.result});
        const d = await r.json();
        if(d.status==='ok') { showToast('Imported '+d.imported); loadQueue(); }
    };
    reader.readAsText(file);
}