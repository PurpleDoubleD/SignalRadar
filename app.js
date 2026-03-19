// ============================================================
// SignalRadar v3.0 — Mobilfunk-Abdeckungskarte für Deutschland
// by PurpleDoubleD
// ============================================================

'use strict';

// ─── Config ───────────────────────────────────────────────────
const CONFIG = {
    defaultCenter: [51.2544, 6.3945], // Viersen
    defaultZoom: 12,
    
    overpassEndpoints: [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ],
    overpassTimeout: 45,
    
    signalColors: {
        excellent: '#22c55e',
        good: '#4ade80',
        fair: '#eab308',
        weak: '#f97316',
        poor: '#ef4444',
        none: '#555568',
    },
    
    frequencies: {
        '5G':  { freq: 3600, eirp: 62 },
        '4G':  { freq: 800,  eirp: 60 },
        '3G':  { freq: 2100, eirp: 56 },
        '2G':  { freq: 900,  eirp: 52 },
    },
    towerHeight: 40,
    phoneHeight: 1.5,
    
    heatmapResolution: 6,
    nominatimUrl: 'https://nominatim.openstreetmap.org',
};

// ─── State ────────────────────────────────────────────────────
let map;
let clusterGroup;
let heatmapLayer = null;
let userMarker = null;
let userAccuracyCircle = null;
let userPosition = null;
let towers = [];
let towerIds = new Set();
let activeFilter = 'all';
let isSatellite = true; // Satellite is default
let isHeatmapOn = true; // Heatmap always on — core feature
let isMeasuring = false;
let measurePoints = [];
let measureMarkers = [];
let measureLine = null;
let measurePopup = null;
let tileLayerStreet, tileLayerSat;
let loadedRegions = [];
let loadingTimeout = null;
let currentOverpassIdx = 0;
let searchDebounce = null;
let watchId = null;
let heatmapWorking = false;
let speedTestRunning = false;
let selectedProvider = 'all';

// ─── Utilities ────────────────────────────────────────────────
function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
}

function setLoading(on) {
    document.getElementById('loadingBar').classList.toggle('active', on);
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDist(meters) {
    if (meters < 1000) return `${Math.round(meters)}m`;
    return `${(meters / 1000).toFixed(1)}km`;
}

function hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? { r: parseInt(r[1], 16), g: parseInt(r[2], 16), b: parseInt(r[3], 16) } : { r: 80, g: 80, b: 80 };
}

// ─── Onboarding ───────────────────────────────────────────────
function selectProvider(el) {
    document.querySelectorAll('.provider-option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    selectedProvider = el.dataset.provider;
}

function startApp() {
    const onboarding = document.getElementById('onboarding');
    onboarding.classList.add('hidden');
    setTimeout(() => { onboarding.style.display = 'none'; }, 500);
    
    // Apply selected provider as filter
    if (selectedProvider !== 'all') {
        activeFilter = selectedProvider;
        document.querySelectorAll('.chip').forEach(c => {
            c.classList.toggle('active', c.dataset.filter === selectedProvider);
        });
    }
    
    // Save preference
    try { localStorage.setItem('sr_provider', selectedProvider); } catch(e) {}
    try { localStorage.setItem('sr_onboarded', '1'); } catch(e) {}
    
    // Initialize
    initMap();
}

// Check if already onboarded
function checkOnboarding() {
    try {
        if (localStorage.getItem('sr_onboarded') === '1') {
            const saved = localStorage.getItem('sr_provider') || 'all';
            selectedProvider = saved;
            if (saved !== 'all') {
                activeFilter = saved;
            }
            document.getElementById('onboarding').style.display = 'none';
            initMap();
            return;
        }
    } catch(e) {}
    // Show onboarding
}

// ─── Operator Classification ──────────────────────────────────
function classifyOperator(tags) {
    const fields = [
        tags.operator, tags['operator:de'], tags.name,
        tags['communication:mobile_phone'], tags.network, tags.ref,
        tags.description, tags.owner,
    ].filter(Boolean).map(s => s.toLowerCase()).join(' ');
    
    if (/telefonica|telefónica|o2|e[\-\s]?plus|drillisch|1[&u]1|eplus/.test(fields)) return 'telefonica';
    if (/telekom|t[\-\s]?mobile|deutsche\s*funk|dfmg|dtag/.test(fields)) return 'telekom';
    if (/vodafone|d2|unitymedia/.test(fields)) return 'vodafone';
    if (/american\s*tower|vantage|gip|dfmg/.test(fields)) return 'other';
    if (/db\s|rundfunk|broadcast|tetra|bos[\-\s]|polizei|feuerwehr|amateur/.test(fields)) return 'infrastructure';
    
    return 'other';
}

function getOperatorLabel(type) {
    return {
        telefonica: 'O2 / Telefónica (1&1)',
        telekom: 'Deutsche Telekom',
        vodafone: 'Vodafone',
        other: 'Sonstige',
    }[type] || type;
}

function getOperatorColor(type) {
    return {
        telefonica: '#0ea5e9',
        telekom: '#e20074',
        vodafone: '#e60000',
        other: '#6b7280',
    }[type] || '#6b7280';
}

// ─── Signal Calculation (COST 231 Hata) ──────────────────────
function calculateSignal(distKm, freqMHz, eirp, towerH = CONFIG.towerHeight) {
    if (distKm <= 0) distKm = 0.01;
    if (distKm > 35) return -130;
    
    const hb = towerH;
    const hm = CONFIG.phoneHeight;
    const f = freqMHz;
    const d = distKm;
    
    const aHm = (1.1 * Math.log10(f) - 0.7) * hm - (1.56 * Math.log10(f) - 0.8);
    let pathLoss = 46.3 + 33.9 * Math.log10(f) - 13.82 * Math.log10(hb) - aHm
                   + (44.9 - 6.55 * Math.log10(hb)) * Math.log10(d);
    pathLoss -= 2 * (Math.log10(f / 28)) ** 2 - 5.4;
    pathLoss += 8;
    
    return Math.round(eirp - pathLoss);
}

function getSignalQuality(dBm) {
    if (dBm > -65)  return { level: 5, label: 'Ausgezeichnet', color: CONFIG.signalColors.excellent, css: 'excellent' };
    if (dBm > -75)  return { level: 4, label: 'Sehr gut',       color: CONFIG.signalColors.good,      css: 'good' };
    if (dBm > -85)  return { level: 3, label: 'Gut',            color: CONFIG.signalColors.fair,       css: 'fair' };
    if (dBm > -95)  return { level: 2, label: 'Schwach',        color: CONFIG.signalColors.weak,       css: 'weak' };
    if (dBm > -110) return { level: 1, label: 'Sehr schwach',   color: CONFIG.signalColors.poor,       css: 'poor' };
    return { level: 0, label: 'Kein Empfang', color: CONFIG.signalColors.none, css: 'poor' };
}

function getBestSignalAt(lat, lng, filterOp = 'all') {
    let bestSignal = -999;
    let bestTower = null;
    let bestTech = '';
    
    const filtered = towers.filter(t => {
        if (t.opType === 'infrastructure') return false;
        if (filterOp === 'all') return true;
        return t.opType === filterOp;
    });
    
    for (const tower of filtered) {
        const dist = getDistanceKm(lat, lng, tower.lat, tower.lon);
        if (dist > 35) continue;
        
        const techs = getTowerTechs(tower);
        const techsToCalc = techs.length > 0 ? techs : ['4G'];
        
        for (const tech of techsToCalc) {
            const cfg = CONFIG.frequencies[tech];
            if (!cfg) continue;
            const signal = calculateSignal(dist, cfg.freq, cfg.eirp, tower.height);
            if (signal > bestSignal) {
                bestSignal = signal;
                bestTower = tower;
                bestTech = tech;
            }
        }
    }
    
    return { signal: bestSignal, tower: bestTower, tech: bestTech };
}

function getTowerTechs(tower) {
    const techs = [];
    const t = tower.tags;
    if (t['communication:2g'] === 'yes' || t['communication:gsm'] === 'yes') techs.push('2G');
    if (t['communication:3g'] === 'yes' || t['communication:umts'] === 'yes') techs.push('3G');
    if (t['communication:4g'] === 'yes' || t['communication:lte'] === 'yes') techs.push('4G');
    if (t['communication:5g'] === 'yes' || t['communication:nr'] === 'yes') techs.push('5G');
    return techs;
}

// ─── Tower Loading (Overpass API) ─────────────────────────────
async function loadTowers(bounds, retries = 2) {
    if (isRegionLoaded(bounds)) return;
    
    setLoading(true);
    
    const s = bounds.getSouth().toFixed(6);
    const w = bounds.getWest().toFixed(6);
    const n = bounds.getNorth().toFixed(6);
    const e = bounds.getEast().toFixed(6);
    
    const query = `[out:json][timeout:${CONFIG.overpassTimeout}];(
        node["man_made"="mast"]["tower:type"="communication"](${s},${w},${n},${e});
        node["communication:mobile_phone"="yes"](${s},${w},${n},${e});
        node["man_made"="tower"]["tower:type"="communication"](${s},${w},${n},${e});
        way["man_made"="mast"]["tower:type"="communication"](${s},${w},${n},${e});
        node["telecom"="antenna"](${s},${w},${n},${e});
        node["man_made"="antenna"](${s},${w},${n},${e});
        node["man_made"="communications_tower"](${s},${w},${n},${e});
        node["telecom"="mast"](${s},${w},${n},${e});
    );out body center;`;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        const endpoint = CONFIG.overpassEndpoints[currentOverpassIdx % CONFIG.overpassEndpoints.length];
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), CONFIG.overpassTimeout * 1000);
            
            const response = await fetch(endpoint, {
                method: 'POST',
                body: 'data=' + encodeURIComponent(query),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                signal: controller.signal,
            });
            
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            
            let added = 0;
            for (const el of data.elements) {
                const id = el.id;
                if (towerIds.has(id)) continue;
                
                const lat = el.lat || (el.center && el.center.lat);
                const lon = el.lon || (el.center && el.center.lon);
                if (!lat || !lon) continue;
                
                const tags = el.tags || {};
                const opType = classifyOperator(tags);
                if (opType === 'infrastructure') continue;
                
                towerIds.add(id);
                towers.push({
                    id, lat, lon,
                    operator: tags.operator || tags.name || 'Unbekannt',
                    opType,
                    height: parseFloat(tags.height) || parseFloat(tags['tower:height']) || CONFIG.towerHeight,
                    tags,
                });
                added++;
            }
            
            markRegionLoaded(bounds);
            renderTowers();
            updateTowerCount();
            
            if (added > 0) toast(`${added} neue Masten geladen`);
            
            setLoading(false);
            return;
            
        } catch (err) {
            console.warn(`Overpass attempt ${attempt + 1} failed (${endpoint}):`, err.message);
            currentOverpassIdx++;
            
            if (attempt === retries) {
                toast('Masten konnten nicht geladen werden');
                setLoading(false);
            } else {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
}

function isRegionLoaded(bounds) {
    return loadedRegions.some(r => r.contains(bounds));
}

function markRegionLoaded(bounds) {
    loadedRegions.push(bounds.pad(0.2));
    if (loadedRegions.length > 20) loadedRegions.shift();
}

// ─── Render Towers ────────────────────────────────────────────
function renderTowers() {
    if (!clusterGroup) return;
    clusterGroup.clearLayers();
    
    const filtered = towers.filter(t => {
        if (activeFilter === 'all') return true;
        return t.opType === activeFilter;
    });
    
    for (const tower of filtered) {
        const icon = L.divIcon({
            className: '',
            html: `<div class="tower-marker ${tower.opType}"></div>`,
            iconSize: [10, 10],
            iconAnchor: [5, 5],
        });
        
        const marker = L.marker([tower.lat, tower.lon], { icon });
        
        const techs = getTowerTechs(tower);
        const techStr = techs.length > 0
            ? techs.map(t => `<span class="net-badge b${t.toLowerCase()}">${t}</span>`).join(' ')
            : '<span style="color:var(--text-tertiary)">nicht angegeben</span>';
        
        const distStr = userPosition
            ? formatDist(getDistanceKm(userPosition.lat, userPosition.lng, tower.lat, tower.lon) * 1000)
            : '--';
        
        marker.bindPopup(`
            <div class="tower-popup">
                <div class="tp-header">
                    <div class="tp-icon ${tower.opType}">📡</div>
                    <div>
                        <div class="tp-title">${getOperatorLabel(tower.opType)}</div>
                        <div class="tp-operator">${tower.operator}</div>
                    </div>
                </div>
                <div class="tp-row"><span class="tp-label">Technologie</span> ${techStr}</div>
                <div class="tp-row"><span class="tp-label">Masthöhe</span> <span class="tp-value">${tower.height}m</span></div>
                <div class="tp-row"><span class="tp-label">Entfernung</span> <span class="tp-value">${distStr}</span></div>
                <div class="tp-row"><span class="tp-label">Koordinaten</span> <span class="tp-value" style="font-size:11px">${tower.lat.toFixed(5)}, ${tower.lon.toFixed(5)}</span></div>
            </div>
        `, { maxWidth: 280, className: '' });
        
        clusterGroup.addLayer(marker);
    }
}

function updateTowerCount() {
    const count = towers.filter(t => {
        if (activeFilter === 'all') return true;
        return t.opType === activeFilter;
    }).length;
    document.getElementById('towerCount').innerHTML = `<span class="num">${count}</span> Masten`;
}

// ─── Signal Display ───────────────────────────────────────────
function updateSignalDisplay(lat, lng) {
    const result = getBestSignalAt(lat, lng, activeFilter);
    const quality = getSignalQuality(result.signal);
    
    const bars = document.querySelectorAll('.signal-bar');
    bars.forEach((bar, i) => {
        bar.className = 'signal-bar';
        if (i < quality.level) bar.classList.add('active', quality.css);
    });
    
    const strengthEl = document.getElementById('signalStrength');
    const detailEl = document.getElementById('signalDetail');
    const dbmEl = document.getElementById('signalDbm');
    
    if (result.tower) {
        const distM = Math.round(getDistanceKm(lat, lng, result.tower.lat, result.tower.lon) * 1000);
        strengthEl.textContent = quality.label;
        strengthEl.style.color = quality.color;
        detailEl.textContent = `${result.tech} · ${getOperatorLabel(result.tower.opType)} · ${formatDist(distM)}`;
        dbmEl.innerHTML = `${result.signal}<span class="unit"> dBm</span>`;
        dbmEl.style.color = quality.color;
    } else {
        strengthEl.textContent = 'Kein Signal';
        strengthEl.style.color = CONFIG.signalColors.none;
        detailEl.textContent = 'Keine Masten in Reichweite';
        dbmEl.innerHTML = `--<span class="unit"> dBm</span>`;
        dbmEl.style.color = CONFIG.signalColors.none;
    }
}

// ─── Heatmap ──────────────────────────────────────────────────
function generateHeatmap() {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    if (!isHeatmapOn || heatmapWorking) return;
    if (map.getZoom() < 11) {
        toast('Zoome näher ran für die Heatmap (≥12)');
        return;
    }
    
    heatmapWorking = true;
    setLoading(true);
    
    requestAnimationFrame(() => {
        try {
            const bounds = map.getBounds();
            const size = map.getSize();
            const res = CONFIG.heatmapResolution;
            const w = Math.ceil(size.x / res);
            const h = Math.ceil(size.y / res);
            
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            const imageData = ctx.createImageData(w, h);
            
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const point = map.containerPointToLatLng([x * res, y * res]);
                    const result = getBestSignalAt(point.lat, point.lng, activeFilter);
                    const quality = getSignalQuality(result.signal);
                    const rgb = hexToRgb(quality.color);
                    const idx = (y * w + x) * 4;
                    
                    if (result.signal > -115) {
                        imageData.data[idx]     = rgb.r;
                        imageData.data[idx + 1] = rgb.g;
                        imageData.data[idx + 2] = rgb.b;
                        imageData.data[idx + 3] = 100;
                    }
                }
            }
            
            ctx.putImageData(imageData, 0, 0);
            
            if (isHeatmapOn) {
                heatmapLayer = L.imageOverlay(canvas.toDataURL(), bounds, {
                    opacity: 0.45,
                    interactive: false,
                });
                heatmapLayer.addTo(map);
            }
        } catch (e) {
            console.error('Heatmap error:', e);
        } finally {
            heatmapWorking = false;
            setLoading(false);
        }
    });
}

// ─── Speed Test ───────────────────────────────────────────────
function toggleSpeedPanel() {
    const panel = document.getElementById('speedPanel');
    const btn = document.getElementById('btnSpeed');
    panel.classList.toggle('open');
    btn.classList.toggle('active');
    // Close compare if open
    document.getElementById('comparePanel').classList.remove('open');
    document.getElementById('btnCompare').classList.remove('active');
}

async function runSpeedTest() {
    if (speedTestRunning) return;
    speedTestRunning = true;
    
    const btn = document.getElementById('speedStartBtn');
    btn.disabled = true;
    btn.textContent = 'Teste Download...';
    
    const downEl = document.getElementById('speedDown');
    const upEl = document.getElementById('speedUp');
    const pingEl = document.getElementById('speedPing');
    
    downEl.textContent = '...';
    upEl.textContent = '...';
    pingEl.textContent = '...';
    
    document.getElementById('gaugeDown').classList.add('testing');
    
    try {
        // Ping test
        const pingStart = performance.now();
        await fetch('https://www.google.com/favicon.ico?t=' + Date.now(), { mode: 'no-cors', cache: 'no-store' });
        const pingTime = Math.round(performance.now() - pingStart);
        pingEl.textContent = pingTime;
        
        // Download test — fetch a known file multiple times
        btn.textContent = 'Teste Download...';
        const downloadUrl = 'https://speed.cloudflare.com/__down?bytes=2000000';
        const dlStart = performance.now();
        let totalBytes = 0;
        
        const dlPromises = [];
        for (let i = 0; i < 3; i++) {
            dlPromises.push(
                fetch(downloadUrl + '&cachebust=' + Date.now() + i, { cache: 'no-store' })
                    .then(r => r.arrayBuffer())
                    .then(buf => { totalBytes += buf.byteLength; })
                    .catch(() => {})
            );
        }
        await Promise.all(dlPromises);
        const dlTime = (performance.now() - dlStart) / 1000;
        const dlSpeed = totalBytes > 0 ? ((totalBytes * 8) / dlTime / 1e6).toFixed(1) : '--';
        downEl.textContent = dlSpeed;
        document.getElementById('gaugeDown').classList.remove('testing');
        
        // Upload test
        btn.textContent = 'Teste Upload...';
        document.getElementById('gaugeUp').classList.add('testing');
        
        const uploadData = new ArrayBuffer(500000);
        const ulStart = performance.now();
        let ulBytes = 0;
        
        const ulPromises = [];
        for (let i = 0; i < 2; i++) {
            ulPromises.push(
                fetch('https://speed.cloudflare.com/__up', {
                    method: 'POST',
                    body: uploadData,
                    cache: 'no-store',
                }).then(() => { ulBytes += uploadData.byteLength; }).catch(() => {})
            );
        }
        await Promise.all(ulPromises);
        const ulTime = (performance.now() - ulStart) / 1000;
        const ulSpeed = ulBytes > 0 ? ((ulBytes * 8) / ulTime / 1e6).toFixed(1) : '--';
        upEl.textContent = ulSpeed;
        document.getElementById('gaugeUp').classList.remove('testing');
        
        btn.textContent = 'Erneut testen';
        toast(`⚡ ${dlSpeed} Mbps ↓ · ${ulSpeed} Mbps ↑ · ${pingTime}ms`);
        
    } catch (err) {
        console.error('Speed test error:', err);
        toast('Speed Test fehlgeschlagen');
        btn.textContent = 'Erneut versuchen';
    } finally {
        speedTestRunning = false;
        btn.disabled = false;
        document.querySelectorAll('.speed-gauge').forEach(g => g.classList.remove('testing'));
    }
}

// ─── Provider Compare ─────────────────────────────────────────
function toggleComparePanel() {
    const panel = document.getElementById('comparePanel');
    const btn = document.getElementById('btnCompare');
    panel.classList.toggle('open');
    btn.classList.toggle('active');
    // Close speed if open
    document.getElementById('speedPanel').classList.remove('open');
    document.getElementById('btnSpeed').classList.remove('active');
    
    if (panel.classList.contains('open')) {
        updateComparePanel();
    }
}

function updateComparePanel() {
    const center = map.getCenter();
    const lat = center.lat;
    const lng = center.lng;
    
    const providers = ['telefonica', 'telekom', 'vodafone'];
    const results = providers.map(p => {
        const result = getBestSignalAt(lat, lng, p);
        const quality = getSignalQuality(result.signal);
        const towerCount = towers.filter(t => t.opType === p).length;
        const nearbyCount = towers.filter(t => {
            if (t.opType !== p) return false;
            return getDistanceKm(lat, lng, t.lat, t.lon) <= 3;
        }).length;
        return { provider: p, ...result, quality, towerCount, nearbyCount };
    });
    
    // Sort by signal strength
    results.sort((a, b) => b.signal - a.signal);
    
    const container = document.getElementById('compareResults');
    const labels = {
        telefonica: 'O2 / 1&1',
        telekom: 'Deutsche Telekom',
        vodafone: 'Vodafone',
    };
    const icons = {
        telefonica: '📶',
        telekom: '📶',
        vodafone: '📶',
    };
    
    container.innerHTML = results.map((r, i) => `
        <div class="compare-card ${r.provider}">
            <div class="compare-logo ${r.provider}">${icons[r.provider]}</div>
            <div class="compare-info">
                <div class="compare-name">${i === 0 ? '👑 ' : ''}${labels[r.provider]}</div>
                <div class="compare-detail">${r.nearbyCount} Masten im Umkreis 3km · ${r.tech || '--'}</div>
            </div>
            <div class="compare-signal">
                <div class="compare-dbm" style="color:${r.quality.color}">${r.signal > -130 ? r.signal : '--'}</div>
                <div class="compare-quality" style="color:${r.quality.color}">${r.quality.label}</div>
            </div>
        </div>
    `).join('');
    
    // Recommendation
    const best = results[0];
    const worst = results[results.length - 1];
    if (best.signal > -130) {
        const diff = best.signal - worst.signal;
        container.innerHTML += `
            <div class="compare-recommendation">
                💡 ${labels[best.provider]} hat hier das stärkste Signal${diff > 10 ? ` (+${diff} dBm vs. ${labels[worst.provider]})` : ''}.
            </div>
        `;
    }
}

// ─── Geocoding (Nominatim) ────────────────────────────────────
async function searchLocation(query) {
    if (!query || query.length < 2) {
        document.getElementById('searchResults').classList.remove('has-results');
        return;
    }
    
    try {
        const url = `${CONFIG.nominatimUrl}/search?format=json&q=${encodeURIComponent(query)}&countrycodes=de&limit=5&addressdetails=1`;
        const response = await fetch(url, { headers: { 'Accept-Language': 'de' } });
        const results = await response.json();
        
        const container = document.getElementById('searchResults');
        container.innerHTML = '';
        
        if (results.length === 0) {
            container.classList.remove('has-results');
            return;
        }
        
        for (const r of results) {
            const item = document.createElement('div');
            item.className = 'search-result-item';
            
            const icon = r.type === 'city' || r.type === 'town' ? '🏙️' :
                         r.type === 'village' ? '🏘️' :
                         r.type === 'postcode' ? '📮' : '📍';
            
            item.innerHTML = `
                <span class="sr-icon">${icon}</span>
                <div>
                    <div class="sr-name">${r.display_name.split(',').slice(0, 2).join(', ')}</div>
                    <div class="sr-detail">${r.display_name.split(',').slice(2, 4).join(', ')}</div>
                </div>
            `;
            
            item.addEventListener('click', () => {
                const lat = parseFloat(r.lat);
                const lon = parseFloat(r.lon);
                map.setView([lat, lon], 14);
                document.getElementById('searchWrap').classList.remove('open');
                document.getElementById('searchBox').value = '';
                container.classList.remove('has-results');
                document.getElementById('btnSearch').classList.remove('active');
                toast(`📍 ${r.display_name.split(',')[0]}`);
            });
            
            container.appendChild(item);
        }
        
        container.classList.add('has-results');
        
    } catch (err) {
        console.error('Geocoding error:', err);
    }
}

// ─── Geolocation ──────────────────────────────────────────────
function locateUser() {
    if (!navigator.geolocation) {
        toast('Geolocation nicht verfügbar');
        return;
    }
    
    toast('Standort wird ermittelt...');
    
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            userPosition = { lat: latitude, lng: longitude };
            
            setUserMarker(latitude, longitude, accuracy);
            map.setView([latitude, longitude], 14);
            updateSignalDisplay(latitude, longitude);
            
            document.getElementById('coordsDisplay').textContent = 
                `${latitude.toFixed(5)}, ${longitude.toFixed(5)} · ±${Math.round(accuracy)}m`;
            
            toast(`Standort gefunden (±${Math.round(accuracy)}m)`);
        },
        (err) => {
            console.error('Geolocation error:', err);
            toast('Standort konnte nicht ermittelt werden');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

function setUserMarker(lat, lng, accuracy) {
    if (userMarker) map.removeLayer(userMarker);
    if (userAccuracyCircle) map.removeLayer(userAccuracyCircle);
    
    const icon = L.divIcon({
        className: '',
        html: '<div class="user-marker"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
    });
    
    userMarker = L.marker([lat, lng], { icon, zIndexOffset: 2000 }).addTo(map);
    
    if (accuracy && accuracy < 5000) {
        userAccuracyCircle = L.circle([lat, lng], {
            radius: accuracy,
            color: 'rgba(99,102,241,0.35)',
            fillColor: 'rgba(99,102,241,0.06)',
            weight: 1,
        }).addTo(map);
    }
}

function startWatching() {
    if (!navigator.geolocation) return;
    
    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            userPosition = { lat: latitude, lng: longitude };
            
            if (userMarker) userMarker.setLatLng([latitude, longitude]);
            if (userAccuracyCircle) {
                userAccuracyCircle.setLatLng([latitude, longitude]);
                if (accuracy) userAccuracyCircle.setRadius(accuracy);
            }
        },
        () => {},
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 }
    );
}

// ─── Measure Tool ─────────────────────────────────────────────
function handleMeasureClick(latlng) {
    measurePoints.push(latlng);
    
    const dot = L.circleMarker(latlng, {
        radius: 5,
        color: '#6366f1',
        fillColor: '#818cf8',
        fillOpacity: 1,
        weight: 2,
    }).addTo(map);
    measureMarkers.push(dot);
    
    if (measurePoints.length === 2) {
        const dist = getDistanceKm(
            measurePoints[0].lat, measurePoints[0].lng,
            measurePoints[1].lat, measurePoints[1].lng
        ) * 1000;
        
        if (measureLine) map.removeLayer(measureLine);
        measureLine = L.polyline(measurePoints, {
            color: '#818cf8',
            weight: 2,
            dashArray: '6, 8',
        }).addTo(map);
        
        const mid = L.latLng(
            (measurePoints[0].lat + measurePoints[1].lat) / 2,
            (measurePoints[0].lng + measurePoints[1].lng) / 2
        );
        
        if (measurePopup) map.closePopup(measurePopup);
        measurePopup = L.popup({ closeOnClick: false, className: '' })
            .setLatLng(mid)
            .setContent(`<strong style="font-size:14px;font-family:Inter,sans-serif">${formatDist(dist)}</strong>`)
            .openOn(map);
        
        measurePoints = [];
    }
}

function clearMeasurements() {
    measureMarkers.forEach(m => map.removeLayer(m));
    measureMarkers = [];
    if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
    if (measurePopup) { map.closePopup(measurePopup); measurePopup = null; }
    measurePoints = [];
}

// ─── Map Click ────────────────────────────────────────────────
function onMapClick(e) {
    if (isMeasuring) {
        handleMeasureClick(e.latlng);
        return;
    }
    updateSignalDisplay(e.latlng.lat, e.latlng.lng);
    document.getElementById('coordsDisplay').textContent = 
        `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
}

// ─── Initialize ───────────────────────────────────────────────
function initMap() {
    map = L.map('map', {
        center: CONFIG.defaultCenter,
        zoom: CONFIG.defaultZoom,
        zoomControl: false,
        attributionControl: true,
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        maxZoom: 19,
        minZoom: 5,
    });
    
    tileLayerStreet = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> · <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        errorTileUrl: '',
        crossOrigin: true,
        keepBuffer: 4,
    });
    
    tileLayerSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: '© Esri',
        errorTileUrl: '',
        crossOrigin: true,
        keepBuffer: 6,
        updateWhenZooming: false,
        updateWhenIdle: true,
    });
    
    tileLayerSat.on('tileerror', function(error) {
        console.warn('Satellite tile failed to load:', error.tile?.src);
    });
    
    // Default: satellite map
    tileLayerSat.addTo(map);
    
    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        disableClusteringAtZoom: 16,
        animate: true,
        animateAddingMarkers: false,
        iconCreateFunction: function(cluster) {
            const count = cluster.getChildCount();
            let size = 'small';
            if (count > 50) size = 'large';
            else if (count > 20) size = 'medium';
            return L.divIcon({
                html: `<div>${count}</div>`,
                className: `marker-cluster marker-cluster-${size}`,
                iconSize: L.point(36, 36),
            });
        },
    });
    map.addLayer(clusterGroup);
    
    map.on('click', onMapClick);
    
    map.on('moveend', () => {
        if (loadingTimeout) clearTimeout(loadingTimeout);
        loadingTimeout = setTimeout(() => {
            const zoom = map.getZoom();
            if (zoom >= 9) {
                loadTowers(map.getBounds().pad(0.3)).then(() => {
                    // Only generate heatmap after towers loaded + tiles had time to render
                    if (isHeatmapOn && zoom >= 11) {
                        setTimeout(() => generateHeatmap(), 800);
                    }
                });
            } else if (isHeatmapOn && zoom >= 11) {
                setTimeout(() => generateHeatmap(), 800);
            }
        }, 500);
    });
    
    // ─── Button handlers ──────────────────────────────────────
    
    // Search
    document.getElementById('btnSearch').addEventListener('click', () => {
        const wrap = document.getElementById('searchWrap');
        const btn = document.getElementById('btnSearch');
        const isOpen = wrap.classList.toggle('open');
        btn.classList.toggle('active', isOpen);
        if (isOpen) document.getElementById('searchBox').focus();
        else {
            document.getElementById('searchBox').value = '';
            document.getElementById('searchResults').classList.remove('has-results');
        }
    });
    
    document.getElementById('searchBox').addEventListener('input', (e) => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => searchLocation(e.target.value), 350);
    });
    
    document.getElementById('searchBox').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchLocation(e.target.value);
        }
    });
    
    map.on('click', () => {
        document.getElementById('searchWrap').classList.remove('open');
        document.getElementById('btnSearch').classList.remove('active');
    });
    
    // Locate
    document.getElementById('btnLocate').addEventListener('click', locateUser);
    
    // Satellite toggle
    document.getElementById('btnSatellite').addEventListener('click', () => {
        isSatellite = !isSatellite;
        if (isSatellite) {
            map.removeLayer(tileLayerStreet);
            tileLayerSat.addTo(map);
        } else {
            map.removeLayer(tileLayerSat);
            tileLayerStreet.addTo(map);
        }
        document.getElementById('btnSatellite').classList.toggle('active', isSatellite);
    });
    
    // Speed Test
    document.getElementById('btnSpeed').addEventListener('click', toggleSpeedPanel);
    
    // Compare
    document.getElementById('btnCompare').addEventListener('click', toggleComparePanel);
    
    // Measure
    document.getElementById('btnMeasure').addEventListener('click', () => {
        isMeasuring = !isMeasuring;
        document.getElementById('btnMeasure').classList.toggle('active');
        if (!isMeasuring) clearMeasurements();
        else toast('Tippe 2 Punkte zum Messen');
    });
    
    // Info
    document.getElementById('btnInfo').addEventListener('click', () => {
        document.getElementById('infoModal').classList.add('open');
    });
    
    document.getElementById('infoModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
    });
    
    // Filter chips
    document.querySelectorAll('.chip').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.filter;
            renderTowers();
            updateTowerCount();
            if (isHeatmapOn) generateHeatmap();
            if (userPosition) updateSignalDisplay(userPosition.lat, userPosition.lng);
        });
    });
    
    // Set initial active states
    document.getElementById('btnSatellite').classList.add('active');
    
    // Apply saved filter
    if (activeFilter !== 'all') {
        document.querySelectorAll('.chip').forEach(c => {
            c.classList.toggle('active', c.dataset.filter === activeFilter);
        });
    }
    
    // Initial load — delay heatmap to let tiles load first on mobile
    loadTowers(map.getBounds().pad(0.3)).then(() => {
        if (isHeatmapOn) {
            setTimeout(() => generateHeatmap(), 2000);
        }
    });
    
    locateUser();
    startWatching();
}

// ─── Service Worker ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.log('SW registration failed:', err);
        });
    });
}

// ─── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', checkOnboarding);
