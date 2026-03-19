// ============================================================
// SignalRadar - Mobilfunk-Abdeckungskarte für Deutschland
// ============================================================

// --- Config ---
const CONFIG = {
    defaultCenter: [51.1657, 10.4515], // Mitte Deutschland
    defaultZoom: 7,
    maxTowerLoadRadius: 15000, // meters
    overpassTimeout: 30,
    signalColors: {
        excellent: '#00b894', // > -70 dBm
        good: '#fdcb6e',      // -70 to -85
        fair: '#e17055',      // -85 to -100
        poor: '#d63031',      // < -100
        none: '#636e72',      // no signal
    },
    // Okumura-Hata model parameters
    // For suburban/rural (Wald!)
    frequencies: {
        '5G': 3600,  // MHz
        '4G': 800,   // MHz (LTE 800 - best for rural)
        '3G': 2100,  // MHz
        '2G': 900,   // MHz
    },
    // Typical tower heights
    towerHeight: 40, // meters
    phoneHeight: 1.5, // meters
    // Vegetation attenuation (dB) - ITU-R recommendation
    forestAttenuation: 15, // dB extra loss in forest
};

// --- State ---
let map;
let towerMarkers = L.layerGroup();
let heatmapLayer = null;
let userMarker = null;
let userPosition = null;
let towers = [];
let activeFilter = 'all';
let isSatellite = false;
let isHeatmapOn = false;
let isMeasuring = false;
let measurePoints = [];
let measureLine = null;
let tileLayerStreet, tileLayerSat;
let loadedBounds = null;
let loadingTimeout = null;

// --- Operator classification ---
function classifyOperator(tags) {
    const op = (tags.operator || tags['operator:de'] || '').toLowerCase();
    const network = (tags['communication:mobile_phone'] || tags['network'] || '').toLowerCase();
    const ref = (tags.ref || '').toLowerCase();
    
    if (op.includes('telefonica') || op.includes('o2') || op.includes('eplus') || 
        op.includes('drillisch') || op.includes('1&1') || op.includes('1und1')) {
        return 'telefonica';
    }
    if (op.includes('telekom') || op.includes('t-mobile') || op.includes('deutsche funkturm')) {
        return 'telekom';
    }
    if (op.includes('vodafone') || op.includes('d2')) {
        return 'vodafone';
    }
    if (op.includes('american tower') || op.includes('vantage')) {
        // Tower companies host multiple operators - show as "other"
        return 'other';
    }
    // DB Netz, Rundfunk etc - not mobile
    if (op.includes('db ') || op.includes('rundfunk') || op.includes('broadcasting')) {
        return 'infrastructure';
    }
    return 'other';
}

function getOperatorLabel(type) {
    const labels = {
        telefonica: 'O2 / Telefónica (1&1)',
        telekom: 'Deutsche Telekom',
        vodafone: 'Vodafone',
        other: 'Sonstige / Multi-Operator',
        infrastructure: 'Infrastruktur',
    };
    return labels[type] || type;
}

// --- Signal calculation (Okumura-Hata model) ---
function calculateSignalStrength(distanceKm, frequencyMHz, isForest = false) {
    if (distanceKm <= 0) distanceKm = 0.01;
    
    // COST 231 Hata Model (suburban/rural)
    const hb = CONFIG.towerHeight;
    const hm = CONFIG.phoneHeight;
    const f = frequencyMHz;
    const d = distanceKm;
    
    // Antenna height correction for mobile (small/medium city)
    const aHm = (1.1 * Math.log10(f) - 0.7) * hm - (1.56 * Math.log10(f) - 0.8);
    
    // Path loss (suburban)
    let pathLoss = 46.3 + 33.9 * Math.log10(f) - 13.82 * Math.log10(hb) - aHm
                   + (44.9 - 6.55 * Math.log10(hb)) * Math.log10(d);
    
    // Suburban correction
    pathLoss -= 2 * Math.pow(Math.log10(f / 28), 2) - 5.4;
    
    // Forest attenuation
    if (isForest) {
        pathLoss += CONFIG.forestAttenuation;
    }
    
    // Typical tower EIRP (effective radiated power) in dBm
    const eirp = 60; // ~60 dBm for macro cell
    
    // Received signal strength
    const rss = eirp - pathLoss;
    
    return Math.round(rss);
}

function getSignalQuality(dBm) {
    if (dBm > -70) return { level: 5, label: 'Ausgezeichnet', color: CONFIG.signalColors.excellent, css: 'excellent' };
    if (dBm > -80) return { level: 4, label: 'Gut', color: CONFIG.signalColors.good, css: 'good' };
    if (dBm > -90) return { level: 3, label: 'Befriedigend', color: CONFIG.signalColors.good, css: 'good' };
    if (dBm > -100) return { level: 2, label: 'Schwach', color: CONFIG.signalColors.fair, css: 'fair' };
    if (dBm > -110) return { level: 1, label: 'Sehr schwach', color: CONFIG.signalColors.poor, css: 'poor' };
    return { level: 0, label: 'Kein Empfang', color: CONFIG.signalColors.none, css: 'poor' };
}

function getBestSignalAtPoint(lat, lng, filterOp = 'all') {
    let bestSignal = -999;
    let bestTower = null;
    let bestFreq = '';
    
    const filteredTowers = towers.filter(t => {
        if (filterOp === 'all') return t.opType !== 'infrastructure';
        return t.opType === filterOp;
    });
    
    for (const tower of filteredTowers) {
        const dist = getDistanceKm(lat, lng, tower.lat, tower.lon);
        if (dist > 30) continue; // Skip towers > 30km away
        
        // Check if the point is likely in a forest (we'll use a simple heuristic)
        // In a real app, we'd query OSM landuse data
        const isForest = false; // Will be enhanced later
        
        // Calculate for best frequency (LTE 800 for rural = best penetration)
        for (const [tech, freq] of Object.entries(CONFIG.frequencies)) {
            const signal = calculateSignalStrength(dist, freq, isForest);
            if (signal > bestSignal) {
                bestSignal = signal;
                bestTower = tower;
                bestFreq = tech;
            }
        }
    }
    
    return { signal: bestSignal, tower: bestTower, tech: bestFreq };
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// --- Load towers from Overpass API ---
async function loadTowers(bounds) {
    const loading = document.getElementById('loading');
    loading.classList.add('show');
    
    const s = bounds.getSouth();
    const w = bounds.getWest();
    const n = bounds.getNorth();
    const e = bounds.getEast();
    
    const query = `[out:json][timeout:${CONFIG.overpassTimeout}];(
        node["man_made"="mast"]["tower:type"="communication"](${s},${w},${n},${e});
        node["communication:mobile_phone"="yes"](${s},${w},${n},${e});
        node["man_made"="tower"]["tower:type"="communication"](${s},${w},${n},${e});
    );out body;`;
    
    try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        
        const data = await response.json();
        
        // Deduplicate by ID
        const existingIds = new Set(towers.map(t => t.id));
        const newTowers = [];
        
        for (const element of data.elements) {
            if (existingIds.has(element.id)) continue;
            
            const tags = element.tags || {};
            const opType = classifyOperator(tags);
            
            newTowers.push({
                id: element.id,
                lat: element.lat,
                lon: element.lon,
                operator: tags.operator || 'Unbekannt',
                opType: opType,
                height: parseFloat(tags.height) || CONFIG.towerHeight,
                tags: tags,
            });
        }
        
        towers = towers.concat(newTowers);
        renderTowers();
        
        document.getElementById('towerCount').textContent = `${towers.filter(t => t.opType !== 'infrastructure').length} Masten`;
        
    } catch (err) {
        console.error('Overpass API error:', err);
    } finally {
        loading.classList.remove('show');
    }
}

// --- Render tower markers ---
function renderTowers() {
    towerMarkers.clearLayers();
    
    const filtered = towers.filter(t => {
        if (t.opType === 'infrastructure') return false;
        if (activeFilter === 'all') return true;
        return t.opType === activeFilter;
    });
    
    for (const tower of filtered) {
        const icon = L.divIcon({
            className: '',
            html: `<div class="tower-marker ${tower.opType}"></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });
        
        const marker = L.marker([tower.lat, tower.lon], { icon });
        
        // Build popup content
        const techs = [];
        if (tower.tags['communication:2g'] === 'yes' || tower.tags['communication:gsm'] === 'yes') techs.push('<span class="network-badge n2g">2G</span>');
        if (tower.tags['communication:3g'] === 'yes' || tower.tags['communication:umts'] === 'yes') techs.push('<span class="network-badge n3g">3G</span>');
        if (tower.tags['communication:4g'] === 'yes' || tower.tags['communication:lte'] === 'yes') techs.push('<span class="network-badge n4g">4G</span>');
        if (tower.tags['communication:5g'] === 'yes' || tower.tags['communication:nr'] === 'yes') techs.push('<span class="network-badge n5g">5G</span>');
        
        const techStr = techs.length > 0 ? techs.join(' ') : '<span style="color:#888">Unbekannt</span>';
        
        const distStr = userPosition 
            ? `${(getDistanceKm(userPosition.lat, userPosition.lng, tower.lat, tower.lon) * 1000).toFixed(0)}m`
            : '--';
        
        marker.bindPopup(`
            <div class="tower-popup">
                <div class="tp-title">📡 ${getOperatorLabel(tower.opType)}</div>
                <div class="tp-row"><span class="tp-label">Betreiber:</span> ${tower.operator}</div>
                <div class="tp-row"><span class="tp-label">Technologie:</span> ${techStr}</div>
                <div class="tp-row"><span class="tp-label">Höhe:</span> ${tower.height}m</div>
                <div class="tp-row"><span class="tp-label">Entfernung:</span> ${distStr}</div>
                <div class="tp-row"><span class="tp-label">Koordinaten:</span> ${tower.lat.toFixed(5)}, ${tower.lon.toFixed(5)}</div>
            </div>
        `, { maxWidth: 280 });
        
        towerMarkers.addLayer(marker);
    }
}

// --- Heatmap generation ---
function generateHeatmap() {
    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    
    if (!isHeatmapOn) return;
    
    const bounds = map.getBounds();
    const size = map.getSize();
    
    // Create canvas
    const canvas = document.createElement('canvas');
    const resolution = 4; // pixels per calculation point
    canvas.width = Math.ceil(size.x / resolution);
    canvas.height = Math.ceil(size.y / resolution);
    const ctx = canvas.getContext('2d');
    
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    
    for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
            // Convert pixel to lat/lng
            const point = map.containerPointToLatLng([x * resolution, y * resolution]);
            
            // Get signal at this point
            const result = getBestSignalAtPoint(point.lat, point.lng, activeFilter);
            const quality = getSignalQuality(result.signal);
            
            // Convert color to RGB
            const rgb = hexToRgb(quality.color);
            const idx = (y * canvas.width + x) * 4;
            
            if (result.signal > -115) {
                imageData.data[idx] = rgb.r;
                imageData.data[idx + 1] = rgb.g;
                imageData.data[idx + 2] = rgb.b;
                imageData.data[idx + 3] = 160; // alpha
            } else {
                imageData.data[idx + 3] = 0; // transparent = no signal
            }
        }
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Add as image overlay
    heatmapLayer = L.imageOverlay(canvas.toDataURL(), bounds, {
        opacity: 0.45,
        interactive: false,
    });
    heatmapLayer.addTo(map);
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
    } : { r: 128, g: 128, b: 128 };
}

// --- Update signal display ---
function updateSignalDisplay(lat, lng) {
    const result = getBestSignalAtPoint(lat, lng, activeFilter === 'all' ? 'all' : activeFilter);
    const quality = getSignalQuality(result.signal);
    
    // Update bars
    const bars = document.querySelectorAll('.signal-bar');
    bars.forEach((bar, i) => {
        bar.className = 'signal-bar';
        if (i < quality.level) {
            bar.classList.add('active', quality.css);
        }
    });
    
    // Update text
    const strengthEl = document.getElementById('signalStrength');
    const detailEl = document.getElementById('signalDetail');
    
    if (result.tower) {
        const distM = Math.round(getDistanceKm(lat, lng, result.tower.lat, result.tower.lon) * 1000);
        strengthEl.textContent = `${quality.label} (${result.signal} dBm)`;
        strengthEl.style.color = quality.color;
        detailEl.textContent = `${result.tech} via ${getOperatorLabel(result.tower.opType)} • ${distM}m entfernt`;
    } else {
        strengthEl.textContent = 'Kein Signal';
        strengthEl.style.color = CONFIG.signalColors.none;
        detailEl.textContent = 'Keine Masten in Reichweite gefunden';
    }
}

// --- Map click handler ---
function onMapClick(e) {
    if (isMeasuring) {
        handleMeasureClick(e.latlng);
        return;
    }
    
    updateSignalDisplay(e.latlng.lat, e.latlng.lng);
    
    // Update coords display
    document.getElementById('coordsDisplay').textContent = 
        `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
}

// --- Measure tool ---
function handleMeasureClick(latlng) {
    measurePoints.push(latlng);
    
    L.circleMarker(latlng, {
        radius: 5,
        color: '#6c5ce7',
        fillColor: '#6c5ce7',
        fillOpacity: 1,
    }).addTo(map);
    
    if (measurePoints.length >= 2) {
        const dist = getDistanceKm(
            measurePoints[0].lat, measurePoints[0].lng,
            measurePoints[1].lat, measurePoints[1].lng
        ) * 1000;
        
        if (measureLine) map.removeLayer(measureLine);
        measureLine = L.polyline(measurePoints, {
            color: '#6c5ce7',
            weight: 3,
            dashArray: '8, 8',
        }).addTo(map);
        
        // Show distance
        const midLat = (measurePoints[0].lat + measurePoints[1].lat) / 2;
        const midLng = (measurePoints[0].lng + measurePoints[1].lng) / 2;
        
        L.popup()
            .setLatLng([midLat, midLng])
            .setContent(`<strong>${dist < 1000 ? dist.toFixed(0) + 'm' : (dist/1000).toFixed(2) + 'km'}</strong>`)
            .openOn(map);
        
        // Reset for next measurement
        measurePoints = [];
    }
}

// --- Geolocation ---
function locateUser() {
    if (!navigator.geolocation) {
        alert('Geolocation wird von deinem Browser nicht unterstützt.');
        return;
    }
    
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude, longitude, accuracy } = pos.coords;
            userPosition = { lat: latitude, lng: longitude };
            
            if (userMarker) map.removeLayer(userMarker);
            
            const icon = L.divIcon({
                className: '',
                html: '<div class="user-marker"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
            });
            
            userMarker = L.marker([latitude, longitude], { icon, zIndexOffset: 1000 });
            userMarker.addTo(map);
            
            // Add accuracy circle
            L.circle([latitude, longitude], {
                radius: accuracy,
                color: '#6c5ce7',
                fillColor: '#6c5ce7',
                fillOpacity: 0.1,
                weight: 1,
            }).addTo(map);
            
            map.setView([latitude, longitude], 14);
            
            updateSignalDisplay(latitude, longitude);
            document.getElementById('coordsDisplay').textContent = 
                `${latitude.toFixed(5)}, ${longitude.toFixed(5)} (±${Math.round(accuracy)}m)`;
        },
        (err) => {
            console.error('Geolocation error:', err);
            alert('Standort konnte nicht ermittelt werden: ' + err.message);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// --- Watch position (continuous) ---
function watchPosition() {
    if (!navigator.geolocation) return;
    
    navigator.geolocation.watchPosition(
        (pos) => {
            const { latitude, longitude } = pos.coords;
            userPosition = { lat: latitude, lng: longitude };
            
            if (userMarker) {
                userMarker.setLatLng([latitude, longitude]);
            }
            
            updateSignalDisplay(latitude, longitude);
        },
        () => {},
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 }
    );
}

// --- Initialize map ---
function initMap() {
    map = L.map('map', {
        center: CONFIG.defaultCenter,
        zoom: CONFIG.defaultZoom,
        zoomControl: false,
        attributionControl: true,
    });
    
    // Street layer (default)
    tileLayerStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    });
    
    // Satellite layer
    tileLayerSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: '© Esri'
    });
    
    tileLayerStreet.addTo(map);
    towerMarkers.addTo(map);
    
    // Event handlers
    map.on('click', onMapClick);
    
    map.on('moveend', () => {
        if (loadingTimeout) clearTimeout(loadingTimeout);
        loadingTimeout = setTimeout(() => {
            const zoom = map.getZoom();
            if (zoom >= 10) { // Only load towers when zoomed in enough
                const bounds = map.getBounds();
                // Check if we need to load more
                if (!loadedBounds || !loadedBounds.contains(bounds)) {
                    loadTowers(bounds.pad(0.3)); // Load 30% extra around viewport
                    loadedBounds = bounds.pad(0.5);
                }
            }
            
            if (isHeatmapOn && zoom >= 12) {
                generateHeatmap();
            }
        }, 500);
    });
    
    // Button handlers
    document.getElementById('btnLocate').addEventListener('click', () => {
        locateUser();
    });
    
    document.getElementById('btnSatellite').addEventListener('click', () => {
        isSatellite = !isSatellite;
        if (isSatellite) {
            map.removeLayer(tileLayerStreet);
            tileLayerSat.addTo(map);
        } else {
            map.removeLayer(tileLayerSat);
            tileLayerStreet.addTo(map);
        }
        document.getElementById('btnSatellite').classList.toggle('active');
    });
    
    document.getElementById('btnHeatmap').addEventListener('click', () => {
        isHeatmapOn = !isHeatmapOn;
        document.getElementById('btnHeatmap').classList.toggle('active');
        if (isHeatmapOn) {
            generateHeatmap();
        } else if (heatmapLayer) {
            map.removeLayer(heatmapLayer);
            heatmapLayer = null;
        }
    });
    
    document.getElementById('btnMeasure').addEventListener('click', () => {
        isMeasuring = !isMeasuring;
        document.getElementById('btnMeasure').classList.toggle('active');
        measurePoints = [];
        if (measureLine) {
            map.removeLayer(measureLine);
            measureLine = null;
        }
    });
    
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.filter;
            renderTowers();
            if (isHeatmapOn) generateHeatmap();
            if (userPosition) updateSignalDisplay(userPosition.lat, userPosition.lng);
        });
    });
    
    // Try to get user location on startup
    locateUser();
    watchPosition();
}

// --- Service Worker Registration (PWA) ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.log('SW registration failed:', err);
        });
    });
}

// --- Init ---
document.addEventListener('DOMContentLoaded', initMap);
