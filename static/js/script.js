// OwrtBox Player - COREv10 (Dual Server Mode)
let browserAudio = null, isSeeking = false, currentLyricIndex = -1;
let lastFrameTime = performance.now(), globalTime = 0, isPlaying = false, totalDuration = 0;
let activeKnob = null, activeKnobRect = null, volTimer = null, eqTimer = null, balTimeout = null;
let lyricsData = [], lyricsType = '', lastLyricsTitle = '', isMuted = false, shuffleMode = false;
let audioInitialized = false;

// WebAudio (initialized ONCE)
let audioCtx = null, sourceNode = null, gainNode = null, pannerNode = null;
let eqFilters = [];

let settings;
try { settings = JSON.parse(localStorage.getItem('owrtmb_set')) || getDefaults(); }
catch(e) { settings = getDefaults(); }

// SERVER CONFIG - single server for both modes (no CORS issues)
let playMode = localStorage.getItem('owrtmb_playmode') || 'server';

function getDefaults() { return { f1:0,f2:0,f3:0,f4:0,f5:0,f6:0,f7:0,f8:0,f9:0,f10:0, vol:50, active_preset:'Normal' }; }

// ====== API HELPER ======
function api(path) { return path; }

// ====== WEB AUDIO (ONE-TIME INIT) ======
function initWebAudioOnce() {
    if (audioInitialized || !browserAudio) return;
    audioInitialized = true;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        sourceNode = audioCtx.createMediaElementSource(browserAudio);
        gainNode = audioCtx.createGain();
        gainNode.gain.value = (settings.vol || 50) / 100;
        pannerNode = audioCtx.createStereoPanner();
        pannerNode.pan.value = 0;
        const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        eqFilters = [];
        for (let i = 0; i < 10; i++) {
            const filter = audioCtx.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = freqs[i];
            filter.Q.value = 1.0;
            filter.gain.value = settings['f' + (i+1)] || 0;
            eqFilters.push(filter);
        }
        sourceNode.connect(gainNode);
        if (eqFilters.length > 0) {
            gainNode.connect(eqFilters[0]);
            for (let i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1]);
            eqFilters[eqFilters.length - 1].connect(pannerNode);
        } else { gainNode.connect(pannerNode); }
        pannerNode.connect(audioCtx.destination);
        if (audioCtx.state === 'suspended') {
            document.addEventListener('click', () => { if (audioCtx.state === 'suspended') audioCtx.resume(); }, { once: true });
        }
    } catch(e) { console.log("WebAudio not supported:", e); audioInitialized = false; }
}

function updateWebAudioEQ() {
    if (!audioCtx || eqFilters.length === 0) return;
    for (let i = 0; i < 10; i++) eqFilters[i].gain.value = settings['f' + (i+1)] || 0;
}
function updateWebAudioBalance(val) { if (pannerNode) pannerNode.pan.value = val / 100; }
function updateWebAudioVolume(v) { if (gainNode) gainNode.gain.value = v / 100; }

// ====== INIT ======
window.onload = () => {
    browserAudio = document.getElementById('browser-audio');
    if(browserAudio) {
        browserAudio.addEventListener('timeupdate', onBrowserTime);
        browserAudio.addEventListener('ended', onBrowserEnd);
        browserAudio.addEventListener('loadedmetadata', () => { totalDuration = browserAudio.duration; });
        browserAudio.addEventListener('error', function() {
            // Ignore empty source errors from stop() 
            if (this.error && this.error.message && this.error.message.includes('empty')) return;
            showToast('Audio error: ' + (this.error ? this.error.message : 'unknown'));
        });
        browserAudio.addEventListener('play', () => {
            if (!audioInitialized) { initWebAudioOnce(); }
            else if (audioCtx && audioCtx.state === 'suspended') { audioCtx.resume(); }
        }, { once: true });
        document.addEventListener('click', initWebAudioOnce, { once: true });
    }
    updateUI(); setupKnobs(); checkBitPerfect(); checkCrossfeed(); initPath();
    initVol(); initKeyboard();

    document.getElementById('mode-' + playMode).classList.add('active');
    if(playMode === 'browser') document.getElementById('mode-device').classList.remove('active');

    const pb = document.getElementById('pb');
    if(pb) {
        pb.addEventListener('mousedown', () => isSeeking = true);
        pb.addEventListener('touchstart', () => isSeeking = true, {passive:true});
        pb.addEventListener('change', (e) => {
            isSeeking = false; const p = parseFloat(e.target.value);
            globalTime = (p / 100) * totalDuration;
            if(playMode === 'browser' && browserAudio) browserAudio.currentTime = globalTime;
            else fetch(api('/control/seek?val=' + p));
        });
    }
    if(localStorage.getItem('owrtmb_theme') === 'light') document.body.classList.add('light');
    if(localStorage.getItem('owrtmb_muted') === 'true') { isMuted = true; updateMuteBtn(); }
    const bs = document.getElementById('balanceSlider');
    if(bs) bs.addEventListener('input', () => updateBalance(parseInt(bs.value)));
    const vs = document.getElementById('vol-slider');
    if(vs) {
        vs.value = settings.vol || 50;
        document.getElementById('vol-val').textContent = (settings.vol || 50) + '%';
        vs.addEventListener('input', () => {
            const v = parseInt(vs.value);
            settings.vol = v; localStorage.setItem('owrtmb_set', JSON.stringify(settings));
            document.getElementById('vol-val').textContent = v + '%';
            if(playMode === 'browser') {
                if(browserAudio) browserAudio.volume = v / 100;
                updateWebAudioVolume(v);
            } else fetch(api('/control/volume?val=' + v));
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
    document.getElementById('vol-val').textContent = v + '%';
    if(playMode === 'browser') {
        if(browserAudio) browserAudio.volume = v / 100;
        updateWebAudioVolume(v);
    } else fetch(api('/control/volume?val=' + v));
}

// ====== MUTE ======
function toggleMute() {
    isMuted = !isMuted;
    localStorage.setItem('owrtmb_muted', isMuted ? 'true' : 'false');
    updateMuteBtn();
    const vol = isMuted ? 0 : (settings.vol || 50);
    if(playMode === 'browser') {
        if(browserAudio) browserAudio.volume = vol / 100;
        updateWebAudioVolume(vol);
    } else fetch(api('/control/volume?val=' + vol));
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
    if(playMode === 'server') switchPlayMode('browser');
    playBrowserAudio(api('/radio_proxy?url=' + encodeURIComponent(url)), 'Radio Stream');
    setText('tit', 'Radio Stream'); setText('art', 'Live Stream'); setText('tech-specs', 'STREAMING');
    updateModeIndicator();
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
function onBrowserEnd() { if(playMode === 'browser') nextBrowserTrack(); }

function playBrowserAudio(src, title) {
    if(!browserAudio) return;
    // Reset lyrics data for new track
    lyricsData = [];
    lyricsType = '';
    currentLyricIndex = -1;
    lastLyricsTitle = title || '';

    browserAudio.src = src;
    browserAudio.volume = (settings.vol || 50) / 100;
    let displayTitle = title || 'Unknown';
    let displayArtist = 'Playing';
    if (displayTitle.includes(' - ')) {
        const parts = displayTitle.split(' - ');
        displayArtist = parts[0].trim();
        displayTitle = parts[1].trim();
    }
    setText('tit', displayTitle);
    setText('art', displayArtist);
    setText('tech-specs', 'STREAMING');
    lastLyricsTitle = displayTitle; // Store final display title for sync guard
    document.body.classList.add('playing');
    isPlaying = true;
    updatePlayBtn();
    const promise = browserAudio.play();
    if (promise) promise.catch((e) => {
        if (e.name === 'NotAllowedError') {
            showToast('Tap to play');
            document.addEventListener('click', () => { browserAudio.play().catch(() => {}); }, { once: true });
        } else showToast('Play: ' + e.message);
    });
}

function nextBrowserTrack() {
    fetch(api('/play/next_browser')).then(r => r.json()).then(d => {
        if(d.index >= 0) {
            const src = d.link.includes('youtube') || d.link.includes('youtu.be')
                ? api('/youtube_proxy?url=' + encodeURIComponent(d.link))
                : api('/stream?path=' + encodeURIComponent(d.link));
            playBrowserAudio(src, d.title);
            updateMiniQueue();
        } else {
            isPlaying = false; updatePlayBtn(); document.body.classList.remove('playing');
        }
    });
}

// ====== PLAY ======
function togglePlay() {
    if(playMode === 'browser') {
        if(isPlaying) { browserAudio.pause(); isPlaying = false; updatePlayBtn(); document.body.classList.remove('playing'); }
        else {
            if (browserAudio && browserAudio.src && browserAudio.src !== '') {
                browserAudio.play().catch(() => {}); isPlaying = true; updatePlayBtn(); document.body.classList.add('playing');
            } else {
                fetch(api('/play/current')).then(r => r.json()).then(d => {
                    if(d.index >= 0 && d.link) {
                        const src = d.link.includes('youtube') || d.link.includes('youtu.be')
                            ? api('/youtube_proxy?url=' + encodeURIComponent(d.link))
                            : api('/stream?path=' + encodeURIComponent(d.link));
                        playBrowserAudio(src, d.title);
                    }
                });
            }
        }
    } else {
        fetch(api('/control/pause')).then(() => {
            isPlaying = !isPlaying; updatePlayBtn(); document.body.classList.toggle('playing', isPlaying);
        });
    }
}
function updatePlayBtn() { const btn = document.getElementById('pi'); if(btn) btn.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play'; }

// ====== MODE ======
function updateModeIndicator() {
    const mi = document.getElementById('mode-indicator');
    if(!mi) return;
    const isSrv = playMode === 'server';
    mi.innerHTML = isSrv ? '<i class="fa-solid fa-server"></i> Device Mode' : '<i class="fa-solid fa-desktop"></i> Browser Mode';
    mi.style.color = isSrv ? 'var(--accent)' : 'var(--dim)';
}

function switchPlayMode(mode) {
    playMode = mode;
    localStorage.setItem('owrtmb_playmode', mode);
    document.getElementById('mode-device').classList.toggle('active', mode === 'server');
    document.getElementById('mode-browser').classList.toggle('active', mode === 'browser');
    if(mode === 'browser' && browserAudio) browserAudio.pause();
    updateModeIndicator();
}

function togglePlayMode() {
    const newMode = playMode === 'server' ? 'browser' : 'server';
    const oldMode = playMode;
    
    // Save current playback state before switching
    const currentTime = globalTime;
    
    fetch('/play/current').then(r => r.json()).then(cur => {
        if (cur.index >= 0 && cur.link) {
            // There's an active track - continue playback in new mode
            if (oldMode === 'server' && newMode === 'browser') {
                // Server → Browser: pause mpv, then play via browser audio
                switchPlayMode('browser');
                setTimeout(() => {
                    const src = cur.link.includes('youtube') || cur.link.includes('youtu.be')
                        ? '/youtube_proxy?url=' + encodeURIComponent(cur.link)
                        : '/stream?path=' + encodeURIComponent(cur.link);
                    browserAudio.src = src;
                    browserAudio.volume = (settings.vol || 50) / 100;
                    // Set title/artist
                    let displayTitle = cur.title || 'Unknown';
                    let displayArtist = 'Playing';
                    if (displayTitle.includes(' - ')) {
                        const parts = displayTitle.split(' - ');
                        displayArtist = parts[0].trim();
                        displayTitle = parts[1].trim();
                    }
                    setText('tit', displayTitle);
                    setText('art', displayArtist);
                    setText('tech-specs', 'STREAMING');
                    document.body.classList.add('playing');
                    isPlaying = true;
                    updatePlayBtn();
                    const promise = browserAudio.play();
                    if (promise) promise.catch((e) => {
                        if (e.name === 'NotAllowedError') {
                            showToast('Tap to play');
                            document.addEventListener('click', () => { browserAudio.play().catch(() => {}); }, { once: true });
                        }
                    });
                }, 300);
            } else if (oldMode === 'browser' && newMode === 'server') {
                // Browser → Server: play via mpv
                switchPlayMode('server');
                setTimeout(() => {
                    fetch('/play?url=' + encodeURIComponent(cur.link) + '&mode=play_now&title=' + encodeURIComponent(cur.title));
                    showToast('Continuing on Device...');
                }, 200);
            } else {
                switchPlayMode(newMode);
            }
        } else {
            // No active track, just switch
            switchPlayMode(newMode);
        }
    }).catch(() => {
        // Fallback: just switch mode
        switchPlayMode(newMode);
    });
    
    showToast('Mode: ' + (newMode === 'server' ? 'Device (MPV)' : 'Browser'));
}

// ====== KNOBS ======
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
    let x = (e.touches ? e.touches[0].clientX : e.clientX) - cx, y = (e.touches ? e.touches[0].clientY : e.clientY) - cy;
    let deg = Math.atan2(y, x) * (180 / Math.PI) + 90; if(deg < 0) deg += 360;
    if(type === 'vol') return;
    let p = 0; if(deg >= 210) p = (deg - 210) / 300; else if(deg <= 150) p = (150 + deg) / 300; else p = (Math.abs(deg - 210) < Math.abs(deg - 150)) ? 0 : 1;
    let v = Math.round((p * 24) - 12);
    if(settings[type] !== v) { settings[type] = v; updateUI(); sendEq(); }
}
function stopDrag() { activeKnob = null; activeKnobRect = null; }
function updateUI() {
    document.querySelectorAll('.knob.sm').forEach(el => { const t = el.dataset.type; if(!t || t === 'vol') return; const val = settings[t] || 0; const deg = ((val + 12) / 24) * 270 - 135; el.style.transform = 'rotate(' + deg + 'deg)'; });
    localStorage.setItem('owrtmb_set', JSON.stringify(settings));
}
function sendEq() {
    if(eqTimer) clearTimeout(eqTimer);
    eqTimer = setTimeout(() => {
        if (playMode === 'browser') {
            // Browser mode: apply EQ via WebAudio locally
            if (audioInitialized) updateWebAudioEQ();
        } else {
            // Server mode: send EQ to mpv
            let q = []; for(let i = 1; i <= 10; i++) q.push('f' + i + '=' + (settings['f' + i] || 0));
            fetch(api('/control/eq?' + q.join('&')));
        }
    }, 100);
}

// ====== CONTROLS ======
function ctl(action) {
    if(action === 'pause') togglePlay();
    else if(action === 'prev') {
        if(playMode === 'browser') {
            if(globalTime > 3) { globalTime = 0; if(browserAudio) browserAudio.currentTime = 0; }
            else {
                fetch(api('/play/current')).then(r => r.json()).then(cur => {
                    if (cur.index > 0) {
                        fetch(api('/browser_play?url=' + encodeURIComponent(cur.link) + '&mode=play_now&title=' + encodeURIComponent(cur.title)));
                        setTimeout(() => {
                            fetch(api('/play/current')).then(r => r.json()).then(prev => {
                                if (prev.index >= 0 && prev.link) {
                                    const src = prev.link.includes('youtube') || prev.link.includes('youtu.be')
                                        ? api('/youtube_proxy?url=' + encodeURIComponent(prev.link))
                                        : api('/stream?path=' + encodeURIComponent(prev.link));
                                    playBrowserAudio(src, prev.title);
                                }
                            });
                        }, 300);
                    } else if(browserAudio) { browserAudio.currentTime = 0; }
                });
            }
        } else fetch(api('/control/prev'));
    }
    else if(action === 'next') {
        if(playMode === 'browser') {
            if (shuffleMode) {
                // Shuffle mode: pick random track
                fetch(api('/queue/list')).then(r => r.json()).then(d => {
                    if (d.queue.length > 0) {
                        const others = d.queue.filter((_, i) => i !== d.current_index);
                        if (others.length > 0) {
                            const pick = others[Math.floor(Math.random() * others.length)];
                            fetch(api('/browser_play?url=' + encodeURIComponent(pick.link) + '&mode=play_now&title=' + encodeURIComponent(pick.title)));
                            setTimeout(() => {
                                const src = pick.link.includes('youtube') || pick.link.includes('youtu.be')
                                    ? api('/youtube_proxy?url=' + encodeURIComponent(pick.link))
                                    : api('/stream?path=' + encodeURIComponent(pick.link));
                                playBrowserAudio(src, pick.title);
                                setTimeout(() => { loadQueue(); updateMiniQueue(); }, 300);
                            }, 300);
                        }
                    }
                });
            } else {
                nextBrowserTrack();
            }
        } else {
            if (shuffleMode) {
                // Shuffle mode on server: pick random track
                fetch(api('/queue/list')).then(r => r.json()).then(d => {
                    if (d.queue.length > 1) {
                        const others = d.queue.filter((_, i) => i !== d.current_index);
                        if (others.length > 0) {
                            const pick = others[Math.floor(Math.random() * others.length)];
                            fetch(api('/control/jump?index=' + d.queue.indexOf(pick))).then(() => showToast('Random track'));
                        }
                    } else {
                        fetch(api('/control/next'));
                    }
                });
            } else {
                fetch(api('/control/next'));
            }
        }
    }
    else if(action === 'shuffle') {
        // Toggle shuffle mode
        shuffleMode = !shuffleMode;
        const btn = document.getElementById('btn-shuffle') || document.querySelector('[onclick*="shuffle"]');
        if (btn) btn.classList.toggle('active', shuffleMode);
        
        if (playMode === 'browser') {
            showToast(shuffleMode ? '🔀 Shuffle ON' : '🔀 Shuffle OFF');
        } else {
            if (shuffleMode) {
                fetch(api('/control/shuffle')).then(() => showToast('🔀 Shuffle ON'));
            } else {
                showToast('🔀 Shuffle OFF');
            }
        }
    }
    else if(action === 'stop') { if(browserAudio) { browserAudio.pause(); browserAudio.removeAttribute('src'); browserAudio.load(); } if(playMode !== 'browser') fetch(api('/control/stop')); }
    if(['shuffle', 'prev', 'next'].includes(action)) setTimeout(() => { loadQueue(); updateMiniQueue(); }, 500);
}

// ====== SEARCH ======
function searchYt(e) {
    if(e) e.preventDefault();
    const q = document.getElementById('searchInput').value; if(!q) return;
    const popup = document.getElementById('search-popup'); popup.classList.add('show');
    const c = document.getElementById('popup-content');
    c.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">Searching...</div>';
    fetch(api('/search?q=' + encodeURIComponent(q))).then(r => r.json()).then(data => {
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
    const endpoint = playMode === 'browser' ? api('/browser_play') : api('/play');
    fetch(endpoint + '?url=' + encodeURIComponent(url) + '&mode=' + mode + '&title=' + encodeURIComponent(title)).then(r => r.json()).then(d => {
        if(mode === 'play_now') {
            document.body.classList.add('playing'); showToast('▶ ' + (title || 'Track'));
            if(playMode === 'browser') {
                setTimeout(() => {
                    fetch(api('/play/current')).then(r => r.json()).then(p => {
                        if(p.link) {
                            const src = p.link.includes('youtube') || p.link.includes('youtu.be')
                                ? api('/youtube_proxy?url=' + encodeURIComponent(p.link))
                                : api('/stream?path=' + encodeURIComponent(p.link));
                            playBrowserAudio(src, p.title || title);
                        }
                    });
                }, 300);
            } else { isPlaying = true; updatePlayBtn(); }
        } else showToast('+ Queue (' + d.queue_len + ')');
        updateMiniQueue();
    });
}

// ====== STATUS POLL ======
function pollStatus() {
    if (playMode === 'browser') {
        // Browser mode: only update time from local audio element, skip backend
        updateMiniQueue();
        return;
    }
    // Server mode: poll from device backend
    fetch(api('/status')).then(r => r.json()).then(d => {
        // Update lyrics tracking on track change in server mode
        if (d.title && d.title !== 'Ready' && d.title !== lastLyricsTitle) {
            lastLyricsTitle = d.title;
        }
        setText('tit', d.title || 'Ready');
        setText('art', d.artist || 'OwrtBox');
        setText('tech-specs', d.tech_info || 'AWAITING SIGNAL');

        const vs = document.getElementById('vol-slider');
        if(vs && d.volume !== undefined) {
            const sv = parseInt(d.volume);
            if(!isMuted && vs.value != sv) {
                vs.value = sv;
                document.getElementById('vol-val').textContent = sv + '%';
                settings.vol = sv;
            }
        }
        if(d.current_time !== undefined && Math.abs(globalTime - d.current_time) > 0.5) globalTime = d.current_time;
        if(d.total_time) totalDuration = d.total_time;
        setText('t-tot', fmtTime(totalDuration));
        ['genre', 'year'].forEach(id => {
            const el = document.getElementById(id);
            if(el) { el.textContent = d[id] || ''; el.style.display = d[id] ? 'inline-flex' : 'none'; }
        });
        if(d.status === 'playing' && !isPlaying) { isPlaying = true; updatePlayBtn(); document.body.classList.add('playing'); document.getElementById('cover-img').classList.add('spin'); }
        else if(d.status !== 'playing' && isPlaying) { isPlaying = false; updatePlayBtn(); document.body.classList.remove('playing'); document.getElementById('cover-img').classList.remove('spin'); }
        const ci = document.getElementById('cover-img');
        if(ci && d.thumb && ci.src !== d.thumb) ci.src = d.thumb;
        else if(ci && !d.thumb && !ci.src.includes('default.png')) ci.src = '/static/img/default.png';
        updateMiniQueue();
    }).catch(() => {});
}

// ====== UTILS ======
function setText(id, t) { const el = document.getElementById(id); if(el) el.textContent = t; }
function fmtTime(s) { if(!s || isNaN(s)) return '0:00'; let m = Math.floor(s / 60); let sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' + sec : sec); }
function showToast(msg) {
    let box = document.getElementById('toast-box'); if(!box) { box = document.createElement('div'); box.id = 'toast-box'; document.body.appendChild(box); }
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
    box.appendChild(el); setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
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
    const cont = document.getElementById('lyrics-container');
    const title = document.getElementById('tit').innerText;
    
    cont.innerHTML = `
        <div style="margin-top:20px;">
            <i class="fa-solid fa-compact-disc fa-spin" style="font-size:2rem; color:var(--accent);"></i>
            <p style="margin-top:15px; color:#ccc;">Searching for:<br>
            <span style="color:#fff; font-weight:bold;">${title}</span></p>
        </div>`;
    
    if (title === "Ready" || title === "OwrtBox Player") {
        cont.innerHTML = '<div style="margin-top:50px;">Play music to see lyrics</div>';
        return;
    }

    const artist = document.getElementById('art').innerText;
    fetch('/get_lyrics?title=' + encodeURIComponent(title) + '&artist=' + encodeURIComponent(artist))
        .then(r => r.json())
        .then(d => {
            lastLyricsTitle = title;
            lyricsData = [];
            
            if (d.error) {
                cont.innerHTML = `
                    <div style="margin-top:50px; color:#888;">
                        Lyrics not found.<br>
                        <button onclick="fetchLyrics()" class="preset-btn" style="margin-top:20px; background:rgba(255,255,255,0.1);">Retry</button>
                    </div>`;
                return;
            }

            lyricsType = d.type;
            // Always render plain lyrics (strip timestamps if synced)
            let plainText = d.lyrics;
            if (d.type === 'synced') {
                // Remove LRC timestamps like [00:12.34]
                plainText = d.lyrics.replace(/\[\d{2}:\d{2}\.\d{2}\]/g, '').trim();
            }
            cont.innerHTML = '';
            const safeDiv = document.createElement('div');
            safeDiv.style.cssText = "white-space: pre-wrap; line-height: 1.8; color:#eee; font-size:1.1rem; padding: 20px 10px 100px;";
            safeDiv.innerText = plainText;
            cont.appendChild(safeDiv);
        })
        .catch(() => {
            cont.innerHTML = '<div style="margin-top:50px; color:red;">Connection Error</div>';
        });
}
function parseLRC(t) { lyricsData = []; t.split('\n').forEach(line => { const m = line.match(/^\[(\d{2}):(\d{2}\.\d{2})\](.*)/); if(m) { const text = m[3].trim(); if(text) lyricsData.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text }); } }); }
function renderLyrics() { const c = document.getElementById('lyrics-container'); c.innerHTML = ''; currentLyricIndex = -1; lyricsData.forEach((l, i) => { const d = document.createElement('div'); d.className = 'lyric-line'; d.id = 'line-' + i; d.innerText = l.text; d.onclick = () => { globalTime = l.time; }; c.appendChild(d); }); }
function syncLyrics(t) { if(!document.getElementById('lym').classList.contains('active') || lyricsType !== 'synced') return; let idx = -1; for(let i = lyricsData.length - 1; i >= 0; i--) { if(t >= lyricsData[i].time) { idx = i; break } } if(idx !== currentLyricIndex) { const prev = document.getElementById('line-' + currentLyricIndex); if(prev) prev.classList.remove('active'); currentLyricIndex = idx; const act = document.getElementById('line-' + idx); if(act) { act.classList.add('active'); const cont = document.getElementById('lyrics-container'); cont.scrollTo({ top: act.offsetTop - cont.clientHeight / 2 + act.offsetHeight / 2, behavior: 'smooth' }); } } }

// ====== BALANCE ======
function updateBalance(val) {
    if (playMode === 'browser' && audioInitialized) updateWebAudioBalance(val);
    if(balTimeout) clearTimeout(balTimeout);
    balTimeout = setTimeout(() => {
        if (playMode !== 'browser') {
            let l = 1.0, r = 1.0;
            if(val < 0) r = 1 - (Math.abs(val) / 100); else if(val > 0) l = 1 - (val / 100);
            fetch(api('/control/balance?l=' + l.toFixed(2) + '&r=' + r.toFixed(2)));
        }
    }, 100);
}

// ====== OUTPUT ======
function manualOut(t) {
    if (playMode === 'browser') { showToast('Switch to Device Mode for output'); return; }
    fetch(api('/control/output?mode=' + t)); showToast('Output: ' + t.toUpperCase()); tg('om');
}
function openBt() { const p = document.getElementById('bt-panel'); if(p.style.display === 'none') p.style.display = 'block'; else manualOut('bluetooth'); }
function scanBt() {
    if (playMode === 'browser') { showToast('BT only in Device Mode'); return; }
    const l = document.getElementById('bt-list'); l.innerHTML = '<div style="color:#888;padding:4px;">Scanning...</div>';
    fetch(api('/bt/scan')).then(r => r.json()).then(d => {
        l.innerHTML = ''; if(!d.length) { l.innerHTML = '<div style="color:#666;font-size:0.7rem;">No devices</div>'; return; }
        d.forEach(dev => {
            const r = document.createElement('div');
            r.style.cssText = 'padding:6px 0;display:flex;justify-content:space-between;cursor:pointer;font-size:0.7rem;border-bottom:1px solid rgba(255,255,255,0.04);';
            r.innerHTML = '<span>' + dev.name + '</span><small style="color:#888;">' + dev.mac + '</small>';
            r.onclick = () => { fetch(api('/bt/connect?mac=' + dev.mac)).then(r => r.json()).then(d2 => { if(d2.status === 'ok') showToast('BT: ' + d2.name); }) };
            l.appendChild(r);
        });
    });
}

// ====== CROSSFEED & BITPERFECT ======
function checkBitPerfect() {
    if (playMode === 'browser') return;
    fetch(api('/get_bitperfect')).then(r => r.json()).then(d => {
        const dot = document.getElementById('bp-dot'); if(dot) dot.style.display = d.active ? 'block' : 'none';
        const btn = document.getElementById('btn-bp'); if(btn) btn.classList.toggle('active', d.active);
    });
}
function toggleBitPerfect() {
    if (playMode === 'browser') { showToast('BitPerfect only in Device Mode'); return; }
    fetch(api('/control/bitperfect')).then(r => r.json()).then(d => { checkBitPerfect(); showToast(d.bitperfect ? 'Bit Perfect ON' : 'Bit Perfect OFF'); });
}
function checkCrossfeed() {
    if (playMode === 'browser') return;
    fetch(api('/get_crossfeed')).then(r => r.json()).then(d => {
        const dot = document.getElementById('xf-dot'); if(dot) dot.style.display = d.active ? 'block' : 'none';
        const btn = document.getElementById('btn-xf'); if(btn) btn.classList.toggle('active', d.active);
    });
}
function toggleCrossfeed() {
    if (playMode === 'browser') { showToast('Crossfeed only in Device Mode'); return; }
    const btn = document.getElementById('btn-xf'); const state = btn.classList.contains('active') ? 'off' : 'on';
    fetch(api('/control/crossfeed?state=' + state)).then(() => { checkCrossfeed(); showToast(state === 'on' ? 'Crossfeed ON' : 'Crossfeed OFF'); });
}

// ====== LIBRARY ======
function initPath() { fetch(api('/library/tracks')).then(r => r.json()).then(t => { if(t && t.length) loadLibraryDB(); }).catch(() => {}); }
function openLibrary() { tg('pm'); }
function switchTab(t) {
    document.querySelectorAll('#pm .tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + t).classList.add('active');
    document.querySelectorAll('#pm .tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('content-' + t).classList.add('active');
    if(t === 'files') loadLocalFiles(playMode === 'browser' ? '/root/music' : '/root/music');
    if(t === 'saved') loadSavedPlaylists();
    if(t === 'queue') loadQueue();
}
async function loadLocalFiles(path) {
    const l = document.getElementById('lib-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#888;"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
        const items = await (await fetch(api('/get_files?path=' + encodeURIComponent(path)))).json();
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
        fetch(api('/upload'), { method: 'POST', body: form }).then(r => r.json()).then(d => {
            if(d.status === 'ok') { showToast('Uploaded: ' + file.name); if(i === files.length - 1) { status.textContent = 'Upload complete'; loadLocalFiles('/root/uploads'); } }
            else showToast('Upload failed: ' + file.name);
        }).catch(() => showToast('Upload error: ' + file.name));
    });
}
function scanLibrary() {
    if (playMode === 'browser') { showToast('Library scan only in Device Mode'); return; }
    const s = document.getElementById('scan-status'); s.textContent = 'Scanning...';
    fetch(api('/library/scan')).then(() => {
        const iv = setInterval(() => {
            fetch(api('/library/status')).then(r => r.json()).then(d => {
                if(d.scanning) s.textContent = d.progress + '%';
                else { clearInterval(iv); s.textContent = d.total + ' Tracks'; showToast('Library Updated!'); loadLibraryDB(); }
            });
        }, 1000);
    });
}
async function loadLibraryDB() {
    const l = document.getElementById('lib-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</div>';
    try {
        const tracks = await (await fetch(api('/library/tracks'))).json();
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

// ====== PLAYLIST POPUP ======
function togglePlaylistPopup() {
    const popup = document.getElementById('pl-popup');
    if (!popup) return;
    if (popup.classList.contains('active')) { popup.classList.remove('active'); popup.style.display = 'none'; }
    else { popup.style.display = 'flex'; void popup.offsetWidth; popup.classList.add('active'); initPlaylistPopup(); }
}
function initPlaylistPopup() {
    const container = document.getElementById('playlist-popup-content');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:30px;color:#666;"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    fetch(api('/queue/list')).then(r => r.json()).then(d => {
        container.innerHTML = '';
        if (!d.queue.length) { container.innerHTML = '<div style="text-align:center;padding:30px;color:#666;">Queue is empty</div>'; return; }
        d.queue.forEach((item, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;';
            if (i === d.current_index) row.style.background = 'rgba(0,255,0,0.08)';
            const num = document.createElement('span');
            num.style.cssText = 'color:#666;font-size:0.65rem;min-width:20px;font-family:monospace;';
            num.textContent = (i + 1) + '.';
            const info = document.createElement('div'); info.style.cssText = 'flex:1;overflow:hidden;';
            const title = document.createElement('div');
            title.style.cssText = 'font-size:0.7rem;color:' + (i === d.current_index ? 'var(--accent)' : '#eee') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            title.textContent = item.title;
            info.appendChild(title); row.appendChild(num); row.appendChild(info);
            row.onclick = () => {
                togglePlaylistPopup();
                if (playMode === 'browser') {
                    fetch(api('/browser_play?url=' + encodeURIComponent(item.link) + '&mode=play_now&title=' + encodeURIComponent(item.title)));
                    setTimeout(() => {
                        fetch(api('/play/current')).then(r => r.json()).then(p => {
                            if(p.link) {
                                const src = p.link.includes('youtube') || p.link.includes('youtu.be')
                                    ? api('/youtube_proxy?url=' + encodeURIComponent(p.link))
                                    : api('/stream?path=' + encodeURIComponent(p.link));
                                playBrowserAudio(src, p.title || item.title);
                            }
                        });
                    }, 300);
                } else fetch(api('/control/jump?index=' + i)).then(() => showToast('Jump: ' + item.title));
            };
            container.appendChild(row);
        });
    });
}

// ====== MINI QUEUE ======
function updateMiniQueue() {
    const mq = document.getElementById('mini-queue'); const mql = document.getElementById('mini-queue-list');
    if(!mq || !mql) return;
    fetch(api('/queue/list')).then(r => r.json()).then(d => {
        if(d.queue.length > 1 && d.current_index >= 0) {
            mq.style.display = 'block'; mql.innerHTML = '';
            const start = d.current_index + 1;
            for(let i = start; i < Math.min(start + 2, d.queue.length); i++) {
                const item = d.queue[i]; const div = document.createElement('div');
                div.style.cssText = 'font-size:0.6rem;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;padding:1px 0;';
                div.textContent = (i + 1) + '. ' + item.title;
                div.onclick = () => {
                    if (playMode === 'browser') {
                        fetch(api('/browser_play?url=' + encodeURIComponent(item.link) + '&mode=play_now&title=' + encodeURIComponent(item.title)));
                        setTimeout(() => {
                            fetch(api('/play/current')).then(r => r.json()).then(p => {
                                if(p.link) {
                                    const src = p.link.includes('youtube') || p.link.includes('youtu.be')
                                        ? api('/youtube_proxy?url=' + encodeURIComponent(p.link))
                                        : api('/stream?path=' + encodeURIComponent(p.link));
                                    playBrowserAudio(src, p.title || item.title);
                                }
                            });
                        }, 300);
                    } else fetch(api('/control/jump?index=' + i)).then(() => showToast('Jump: ' + item.title));
                };
                mql.appendChild(div);
            }
            if(start + 2 < d.queue.length) {
                const more = document.createElement('div'); more.style.cssText = 'font-size:0.55rem;color:#555;';
                more.textContent = '+' + (d.queue.length - start - 2) + ' more'; mql.appendChild(more);
            }
        } else { mq.style.display = 'none'; }
    }).catch(() => {});
}

// ====== QUEUE ======
async function loadQueue() {
    const l = document.getElementById('queue-list'); l.innerHTML = '';
    try {
        const d = await (await fetch(api('/queue/list'))).json();
        if(!d.queue.length) { l.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">Empty</div>'; return; }
        d.queue.forEach((item, i) => {
            const r = document.createElement('div'); r.className = 'queue-item' + (i === d.current_index ? ' now' : '');
            const info = document.createElement('div'); info.className = 'lib-info';
            const n = document.createElement('div'); n.className = 'lib-name'; n.textContent = item.title;
            if(i === d.current_index) n.style.color = 'var(--accent)';
            info.appendChild(n); r.appendChild(info);
            r.onclick = () => {
                if (playMode === 'browser') {
                    fetch(api('/browser_play?url=' + encodeURIComponent(item.link) + '&mode=play_now&title=' + encodeURIComponent(item.title)));
                    setTimeout(() => {
                        fetch(api('/play/current')).then(r => r.json()).then(p => {
                            if(p.link) {
                                const src = p.link.includes('youtube') || p.link.includes('youtu.be')
                                    ? api('/youtube_proxy?url=' + encodeURIComponent(p.link))
                                    : api('/stream?path=' + encodeURIComponent(p.link));
                                playBrowserAudio(src, p.title || item.title);
                            }
                        });
                    }, 300);
                } else fetch(api('/control/jump?index=' + i)).then(() => showToast('Jump: ' + item.title));
            };
            l.appendChild(r);
        });
    } catch(e) {}
}
function clearQueue() { fetch(api('/queue/clear')).then(() => { loadQueue(); updateMiniQueue(); }); }

// ====== PRESETS ======
function initPresets() {
    const c = document.getElementById('preset-container'); if(!c) return; c.innerHTML = '';
    const list = ["Normal", "Bass", "Rock", "Pop", "Jazz", "Vocal", "Metal", "Classic", "Dance", "Party"];
    list.forEach(n => {
        const b = document.createElement('button'); b.className = 'preset-btn' + (settings.active_preset === n ? ' active' : ''); b.textContent = n;
        b.onclick = () => {
            settings.active_preset = n;
            // Apply preset locally for both modes
            fetch(api('/control/preset?name=' + n)).catch(() => {}).then(r => r ? r.json() : null).then(d => {
                if (d) { for(let k in d) settings[k] = d[k]; }
                updateUI();
                if (playMode === 'browser' && audioInitialized) updateWebAudioEQ();
                tg('pr-om'); showToast('EQ: ' + n);
            });
        };
        c.appendChild(b);
    });
}
function setTimer(m) {
    if (playMode === 'browser') { showToast('Timer only in Device Mode'); return; }
    fetch(api('/system/timer?min=' + m)).then(() => showToast(m > 0 ? 'Sleep ' + m + 'm' : 'Timer Off'));
}

// ====== PLAYLIST ======
async function addPl() {
    const name = document.getElementById('pl-name').value.trim(); const url = document.getElementById('pl-url').value.trim();
    if(!name || !url) return showToast('Name & URL required');
    const list = await (await fetch(api('/get_playlist'))).json();
    list.push({ title: name, link: url, added_at: Date.now() });
    await fetch(api('/save_playlist'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) });
    showToast('Saved!'); loadSavedPlaylists();
}
function loadSavedPlaylists() {
    const l = document.getElementById('pl-list'); l.innerHTML = '<div style="text-align:center;padding:20px;color:#666;">Loading...</div>';
    fetch(api('/get_playlist')).then(r => r.json()).then(data => {
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
async function deletePlItem(idx) { const list = await (await fetch(api('/get_playlist'))).json(); list.splice(idx, 1); await fetch(api('/save_playlist'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) }); loadSavedPlaylists(); showToast('Deleted'); }
function exportM3U() { window.location.href = api('/playlist/export_m3u'); }
function importM3U(e) { const file = e.target.files[0]; if(!file) return; const reader = new FileReader(); reader.onload = async(ev) => { const r = await fetch(api('/playlist/import_m3u'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ev.target.result }); const d = await r.json(); if(d.status === 'ok') { showToast('Imported ' + d.imported); loadQueue(); } }; reader.readAsText(file); }

// ====== VOLUME INIT ======
function initVol() {
    const vs = document.getElementById('vol-slider');
    if(!vs) return;
    settings.vol = settings.vol || 50;
    vs.value = settings.vol;
    document.getElementById('vol-val').textContent = settings.vol + '%';
    if(playMode === 'browser' && browserAudio) browserAudio.volume = settings.vol / 100;
}