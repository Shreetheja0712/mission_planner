import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import appHtml from './app.html?raw';
import { createSocketBridge } from './socketBridge.js';

document.querySelector('#app').innerHTML = appHtml;

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = createSocketBridge();
let isConnected = false;
let droneMarker = null;
let droneHeading = 0;
let homeMarker  = null;
let homeSet     = false;
let roiPolygon  = null;
let roiPoints = [];
let isDrawing = false;
let drawMarkers = [];
let drawPolyline = null;
let waypointMarkers = [];
let currentWpLine = null;
let rtlWaypointMarkers = [];
let missionSnapshot = { status: 'idle' };
let renderedMissionId = null;
let latestBatteryLevel = -1;
const mapHint = document.getElementById('mapHint');
const btnDrawROI = document.getElementById('btnDrawROI');
const drawActions = document.getElementById('drawActions');
const btnUndoPoint = document.getElementById('btnUndoPoint');
const btnFinishROI = document.getElementById('btnFinishROI');
const btnPreviewGrid = document.getElementById('btnPreviewGrid');
const btnClearROI = document.getElementById('btnClearROI');
const btnStartMission = document.getElementById('btnStartMission');
const btnResumeMission = document.getElementById('btnResumeMission');

// ── Map Init ──────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [-35.363261, 149.165230],  // ArduPilot default SITL location (Canberra, AU)
  zoom: 17,
  zoomControl: true,
  attributionControl: false
});

// Tile layers
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 20, attribution: 'Esri World Imagery'
});
const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, attribution: 'CartoDB'
});
const labelLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, opacity: 0.8
});
satelliteLayer.addTo(map);
labelLayer.addTo(map);
let isSatellite = true;

const layerToggle = L.control({ position: 'topright' });
layerToggle.onAdd = () => {
  const btn = L.DomUtil.create('button');
  btn.innerHTML = '🗺 Map View';
  btn.style.cssText = `background:rgba(13,21,32,0.92);color:#00d4ff;border:1px solid #1a2e44;
    border-radius:4px;padding:6px 12px;cursor:pointer;
    font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1px;margin-top:8px;`;
  L.DomEvent.on(btn, 'click', () => {
    isSatellite = !isSatellite;
    if (isSatellite) {
      map.removeLayer(darkLayer); satelliteLayer.addTo(map); labelLayer.addTo(map);
      btn.innerHTML = '🗺 Map View';
    } else {
      map.removeLayer(satelliteLayer); map.removeLayer(labelLayer); darkLayer.addTo(map);
      btn.innerHTML = '🛰 Satellite';
    }
  });
  return btn;
};
layerToggle.addTo(map);

// ── Drone Icon ────────────────────────────────────────────────────────────────
function makeHomeIcon() {
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:32px;height:32px;">
      <div style="
        position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        width:28px;height:28px;border-radius:50%;
        border:2px solid #00ff88;background:rgba(0,255,136,0.15);
        box-shadow:0 0 12px rgba(0,255,136,0.5);
        display:flex;align-items:center;justify-content:center;
      ">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#00ff88">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
        </svg>
      </div>
      <div style="
        position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);
        font-family:'Share Tech Mono',monospace;font-size:9px;
        color:#00ff88;letter-spacing:1px;white-space:nowrap;
        text-shadow:0 0 6px rgba(0,255,136,0.8);
      ">HOME</div>
    </div>`,
    iconSize: [32, 48],
    iconAnchor: [16, 16]
  });
}

function makeDroneIcon(heading) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:36px;height:36px;
      display:flex;align-items:center;justify-content:center;
      transform:rotate(${heading}deg);
      filter:drop-shadow(0 0 8px #00d4ff);
    ">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
        <circle cx="18" cy="18" r="3" fill="#00d4ff"/>
        <line x1="18" y1="4"  x2="18" y2="14" stroke="#00d4ff" stroke-width="2" stroke-linecap="round"/>
        <line x1="18" y1="22" x2="18" y2="32" stroke="#00d4ff" stroke-width="2" stroke-linecap="round"/>
        <line x1="4"  y1="18" x2="14" y2="18" stroke="#00d4ff" stroke-width="2" stroke-linecap="round"/>
        <line x1="22" y1="18" x2="32" y2="18" stroke="#00d4ff" stroke-width="2" stroke-linecap="round"/>
        <circle cx="6"  cy="6"  r="4" fill="none" stroke="#00d4ff" stroke-width="1.5" opacity="0.7"/>
        <circle cx="30" cy="6"  r="4" fill="none" stroke="#00d4ff" stroke-width="1.5" opacity="0.7"/>
        <circle cx="6"  cy="30" r="4" fill="none" stroke="#00d4ff" stroke-width="1.5" opacity="0.7"/>
        <circle cx="30" cy="30" r="4" fill="none" stroke="#00d4ff" stroke-width="1.5" opacity="0.7"/>
      </svg>
    </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on('connect', () => log('Connected to backend', 'info'));
socket.on('disconnect', () => {
  isConnected = false;
  updateConnStatus(false);
  log('Disconnected from backend', 'error');
});

socket.on('connection_status', (data) => {
  isConnected = data.connected;
  updateConnStatus(data.connected);
  if (data.connected) log('Drone link established', 'success');
  else log(data.message || 'Drone not connected', 'warn');
});

socket.on('telemetry', (d) => {
  if (d.error) return;

  // Update header
  document.getElementById('modeBadge').textContent = d.mode || '--';
  const ab = document.getElementById('armedBadge');
  ab.textContent = d.armed ? 'ARMED' : 'DISARMED';
  ab.classList.toggle('armed', d.armed);

  // Update telemetry cards
  document.getElementById('tAlt').innerHTML  = `${d.alt}<span class="telem-unit">m</span>`;
  document.getElementById('tHdg').innerHTML  = `${d.heading}<span class="telem-unit">°</span>`;
  document.getElementById('tSpd').innerHTML  = `${d.groundspeed}<span class="telem-unit">m/s</span>`;
  document.getElementById('tVolt').innerHTML = `${d.battery_voltage}<span class="telem-unit">V</span>`;

  // Battery
  const pct = d.battery_level || 0;
  latestBatteryLevel = d.battery_level;
  document.getElementById('tBattPct').textContent = `${pct}%`;
  const bar = document.getElementById('battBar');
  bar.style.width = `${pct}%`;
  bar.style.background = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
  updateMissionControls();

  // GPS
  const hasFix = d.gps_fix >= 3;
  document.getElementById('gpsDot').classList.toggle('fix', hasFix);
  document.getElementById('gpsText').textContent = hasFix
    ? `Fix ${d.gps_fix} · ${d.satellites} sats`
    : 'No Fix';

  // Coordinates
  if (d.lat && d.lon && d.lat !== 0) {
    document.getElementById('coordDisplay').textContent =
      `${d.lat.toFixed(6)}°, ${d.lon.toFixed(6)}°`;

    const pos = [d.lat, d.lon];

    // Set home marker once on first valid fix
    if (!homeSet && d.gps_fix >= 3) {
      homeSet = true;
      homeMarker = L.marker(pos, { icon: makeHomeIcon(), zIndexOffset: 500 }).addTo(map);
      homeMarker.bindTooltip('Home / Launch Point', {
        permanent: false, direction: 'top',
        className: 'leaflet-tooltip-dark'
      });
      log(`Home point set: ${d.lat.toFixed(6)}, ${d.lon.toFixed(6)}`, 'success');
    }

    // Move / create drone marker
    if (!droneMarker) {
      droneMarker = L.marker(pos, { icon: makeDroneIcon(d.heading), zIndexOffset: 1000 }).addTo(map);
      map.setView(pos, 17);
    } else {
      droneMarker.setLatLng(pos);
      droneMarker.setIcon(makeDroneIcon(d.heading));
    }
  }
});

socket.on('mission_status', (d) => {
  const isErr = d.error;
  const isOk  = d.complete;
  const type  = isErr ? 'error' : isOk ? 'success' : d.paused ? 'warn' : 'info';
  log(d.status, type);

  if (d.progress !== undefined) {
    document.getElementById('progressBar').style.width = d.progress + '%';
  }

  if (d.waypoints) {
    drawWaypoints(d.waypoints);
  }

  updateMissionControls();
});

socket.on('mission_state', applyMissionState);

// ── Connection Status ─────────────────────────────────────────────────────────
function updateConnStatus(online) {
  document.getElementById('connDot').classList.toggle('online', online);
  document.getElementById('connText').textContent = online ? 'DRONE ONLINE' : 'DISCONNECTED';
}

// ── Clock ─────────────────────────────────────────────────────────────────────
setInterval(() => {
  const now = new Date();
  document.getElementById('clockDisplay').textContent =
    now.toTimeString().slice(0,8);
}, 1000);

// ── ROI Drawing ───────────────────────────────────────────────────────────────
function startDrawing() {
  if (missionIsLocked()) {
    log('Resume or abort the active mission before drawing a new ROI', 'warn');
    return;
  }
  clearROI(false);
  isDrawing = true;
  map.getContainer().style.cursor = 'crosshair';
  mapHint.classList.add('visible');
  map.doubleClickZoom.disable();
  updateDrawingStatus();
  setDrawingControls(true);

  map.on('click', onMapClick);
  map.on('dblclick', finishDrawing);
  document.addEventListener('keydown', onDrawingKeyDown);
}

function onMapClick(e) {
  if (!isDrawing) return;

  roiPoints.push([e.latlng.lat, e.latlng.lng]);

  // Keep the first vertex easy to select as the close target.
  const isFirstPoint = roiPoints.length === 1;
  const m = L.circleMarker(e.latlng, {
    radius: isFirstPoint ? 6 : 5,
    color: '#00d4ff',
    fillColor: '#00d4ff',
    fillOpacity: 1,
    weight: isFirstPoint ? 3 : 2,
    bubblingMouseEvents: !isFirstPoint
  }).addTo(map);
  if (isFirstPoint) {
    m.on('click', onFirstVertexClick);
  }
  drawMarkers.push(m);

  updateDraftShape();
  updateDrawingStatus();
}

function updateDraftShape() {
  if (drawPolyline) map.removeLayer(drawPolyline);
  drawPolyline = null;

  if (roiPoints.length >= 3) {
    drawPolyline = L.polygon(roiPoints, {
      color: '#00d4ff',
      fillColor: '#00d4ff',
      fillOpacity: 0.06,
      weight: 1.5,
      dashArray: '6,4',
      opacity: 0.8,
      interactive: false
    }).addTo(map);
  } else if (roiPoints.length > 1) {
    drawPolyline = L.polyline(roiPoints, {
      color: '#00d4ff',
      weight: 1.5,
      dashArray: '6,4',
      opacity: 0.7,
      interactive: false
    }).addTo(map);
  }

  drawMarkers.forEach(m => m.bringToFront());
}

function updateDrawingStatus() {
  const count = roiPoints.length;
  const firstMarker = drawMarkers[0];
  if (firstMarker) {
    if (count >= 3) {
      firstMarker.bindTooltip('Click to close polygon', { direction: 'top', offset: [0, -5] });
    } else {
      firstMarker.unbindTooltip();
    }
  }

  if (count >= 3) {
    document.getElementById('roiInfo').textContent =
      `${count} points - click first point or Finish Polygon to close`;
  } else if (count > 0) {
    document.getElementById('roiInfo').textContent =
      `${count} point${count === 1 ? '' : 's'} - add ${3 - count} more to form an ROI`;
  } else {
    document.getElementById('roiInfo').textContent = 'Click on map to add ROI points...';
  }
  setDrawingControls(isDrawing);
}

function setDrawingControls(active) {
  btnDrawROI.disabled = active || missionIsLocked();
  drawActions.hidden = !active;
  btnUndoPoint.disabled = !active || roiPoints.length === 0;
  btnFinishROI.disabled = !active || roiPoints.length < 3;
}

function onFirstVertexClick(e) {
  if (!isDrawing || roiPoints.length < 3) return;
  if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
  finishDrawing();
}

function undoDrawPoint() {
  if (!isDrawing || roiPoints.length === 0) return;

  roiPoints.pop();
  const marker = drawMarkers.pop();
  map.removeLayer(marker);
  updateDraftShape();
  updateDrawingStatus();
}

function removeDoubleClickDuplicate() {
  if (roiPoints.length < 2) return;

  const finalPoint = map.latLngToContainerPoint(roiPoints[roiPoints.length - 1]);
  const priorPoint = map.latLngToContainerPoint(roiPoints[roiPoints.length - 2]);
  if (finalPoint.distanceTo(priorPoint) <= 10) {
    undoDrawPoint();
  }
}

function onDrawingKeyDown(e) {
  if (!isDrawing || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

  if (e.key === 'Enter' && roiPoints.length >= 3) {
    e.preventDefault();
    finishDrawing();
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && roiPoints.length > 0) {
    e.preventDefault();
    undoDrawPoint();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelDrawing();
  }
}

function stopDrawingInteractions() {
  map.off('click', onMapClick);
  map.off('dblclick', finishDrawing);
  document.removeEventListener('keydown', onDrawingKeyDown);
  map.doubleClickZoom.enable();
  map.getContainer().style.cursor = '';
  mapHint.classList.remove('visible');
  setDrawingControls(false);
}

function finishDrawing(e) {
  if (!isDrawing) return;
  if (e?.originalEvent) L.DomEvent.stop(e.originalEvent);

  // Leaflet emits both click events before dblclick; retain one intended vertex.
  if (e?.type === 'dblclick') removeDoubleClickDuplicate();
  if (roiPoints.length < 3) {
    updateDrawingStatus();
    return;
  }

  isDrawing = false;
  stopDrawingInteractions();

  // Remove preview
  if (drawPolyline) { map.removeLayer(drawPolyline); drawPolyline = null; }
  drawMarkers.forEach(m => map.removeLayer(m));
  drawMarkers = [];

  // Draw filled polygon
  if (roiPolygon) map.removeLayer(roiPolygon);
  roiPolygon = L.polygon(roiPoints, {
    color: '#00d4ff',
    fillColor: '#00d4ff',
    fillOpacity: 0.08,
    weight: 2,
    dashArray: '8,4'
  }).addTo(map);

  map.fitBounds(roiPolygon.getBounds(), { padding: [40, 40] });

  const area = calculatePolygonArea(roiPoints);
  document.getElementById('roiInfo').textContent =
    `ROI: ${roiPoints.length} pts · ~${area.toFixed(0)} m²`;

  btnPreviewGrid.disabled = false;
  btnStartMission.disabled = false;
  log(`ROI defined: ${roiPoints.length} vertices, ~${area.toFixed(0)}m²`, 'success');

  // Auto-preview grid with current settings
  requestGridPreview();
}

function cancelDrawing() {
  clearROI(false);
  log('ROI drawing cancelled', 'warn');
}

function clearROI(shouldLog = true) {
  if (missionIsLocked() && shouldLog !== false) {
    log('Abort the saved mission before clearing its ROI', 'warn');
    return;
  }
  isDrawing = false;
  stopDrawingInteractions();

  if (roiPolygon) { map.removeLayer(roiPolygon); roiPolygon = null; }
  if (drawPolyline) { map.removeLayer(drawPolyline); drawPolyline = null; }
  drawMarkers.forEach(m => map.removeLayer(m)); drawMarkers = [];
  clearWaypoints();
  drawRtlWaypoints([]);

  roiPoints = [];
  document.getElementById('roiInfo').textContent = 'No ROI defined — draw on map';
  btnStartMission.disabled = true;
  btnPreviewGrid.disabled = true;
  document.getElementById('progressBar').style.width = '0%';
  if (shouldLog !== false) log('ROI cleared', 'warn');
  updateMissionControls();
}

function calculatePolygonArea(points) {
  // Shoelace formula in meters (approximate)
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = points[i][1] * 111000 * Math.cos(points[i][0] * Math.PI / 180);
    const yi = points[i][0] * 111000;
    const xj = points[j][1] * 111000 * Math.cos(points[j][0] * Math.PI / 180);
    const yj = points[j][0] * 111000;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2);
}

// ── Waypoint Visualization ────────────────────────────────────────────────────
function makeWaypointIcon(number, isStart) {
  const size = Math.max(20, 12 + String(number).length * 6);
  const startClass = isStart ? ' start' : '';

  return L.divIcon({
    className: 'waypoint-marker',
    html: `<span class="waypoint-marker-label${startClass}">${number}</span>`,
    iconSize: [size, 20],
    iconAnchor: [size / 2, 10]
  });
}

function makeRtlWaypointIcon(number) {
  return L.divIcon({
    className: 'rtl-waypoint-marker',
    html: `<span class="rtl-waypoint-marker-label">RTL WP ${number}</span>`,
    iconSize: [70, 22],
    iconAnchor: [35, 11]
  });
}

function drawWaypoints(waypoints, shouldLog = true) {
  clearWaypoints();

  const latlngs = waypoints.map(w => [w.lat, w.lon]);

  // Grid path line
  currentWpLine = L.polyline(latlngs, {
    color: '#ff6b35',
    weight: 1.5,
    opacity: 0.8,
    dashArray: '4,4'
  }).addTo(map);

  // Numbered waypoint dots make the generated route order visible on the map.
  waypoints.forEach((wp, i) => {
    const m = L.marker([wp.lat, wp.lon], {
      icon: makeWaypointIcon(i + 1, i === 0),
      interactive: false,
      keyboard: false,
      zIndexOffset: 200
    }).addTo(map);
    waypointMarkers.push(m);
  });

  if (shouldLog) log(`Grid path drawn: ${waypoints.length} waypoints`, 'info');
}

function clearWaypoints() {
  waypointMarkers.forEach(m => map.removeLayer(m));
  waypointMarkers = [];
  if (currentWpLine) { map.removeLayer(currentWpLine); currentWpLine = null; }
}

function drawRtlWaypoints(waypoints) {
  rtlWaypointMarkers.forEach(marker => map.removeLayer(marker));
  rtlWaypointMarkers = [];

  waypoints.forEach((wp, index) => {
    const number = wp.number || index + 1;
    const marker = L.marker([wp.lat, wp.lon], {
      icon: makeRtlWaypointIcon(number),
      interactive: false,
      keyboard: false,
      zIndexOffset: 350
    }).addTo(map);
    rtlWaypointMarkers.push(marker);
  });
}

function missionIsLocked() {
  return missionSnapshot.status === 'running' || missionSnapshot.status === 'paused';
}

function updateMissionControls() {
  const locked = missionIsLocked();
  const paused = missionSnapshot.status === 'paused';
  const canResume = paused && latestBatteryLevel > 20;

  btnDrawROI.disabled = isDrawing || locked;
  btnClearROI.disabled = locked;
  btnPreviewGrid.disabled = locked || roiPoints.length < 3;
  btnStartMission.disabled = locked || roiPoints.length < 3;
  btnResumeMission.hidden = !paused;
  btnResumeMission.disabled = !canResume;

  ['missionAlt', 'gridSpacing', 'gridAngle'].forEach((id) => {
    document.getElementById(id).disabled = locked;
  });
  document.querySelectorAll('[data-angle-preset]').forEach((button) => {
    button.disabled = locked;
  });
}

function restoreMissionMap(state) {
  if (Array.isArray(state.polygon) && state.polygon.length >= 3) {
    roiPoints = state.polygon.map(point => [point[0], point[1]]);
    if (roiPolygon) map.removeLayer(roiPolygon);
    roiPolygon = L.polygon(roiPoints, {
      color: '#00d4ff',
      fillColor: '#00d4ff',
      fillOpacity: 0.08,
      weight: 2,
      dashArray: '8,4'
    }).addTo(map);
    document.getElementById('missionAlt').value = state.altitude;
    document.getElementById('gridSpacing').value = state.spacing;
    document.getElementById('gridAngle').value = state.angle;
    document.getElementById('angleDisplay').textContent = state.angle;
  }

  if (Array.isArray(state.waypoints) && state.waypoints.length) {
    drawWaypoints(state.waypoints, false);
  }
  drawRtlWaypoints(state.rtl_waypoints || []);

  if (state.id && renderedMissionId !== state.id && roiPolygon) {
    map.fitBounds(roiPolygon.getBounds(), { padding: [40, 40] });
    renderedMissionId = state.id;
  }
}

function applyMissionState(state) {
  missionSnapshot = state;
  if (state.status === 'running' || state.status === 'paused' || state.status === 'completed') {
    restoreMissionMap(state);
    document.getElementById('progressBar').style.width = `${state.progress || 0}%`;
    if (state.status === 'paused') {
      const latest = (state.rtl_waypoints || []).length;
      document.getElementById('roiInfo').textContent =
        latest > 0
          ? `Mission paused - RTL WP ${latest} saved - recharge and resume`
          : 'Mission paused - recharge and resume pending grid route';
    } else if (state.status === 'running') {
      document.getElementById('roiInfo').textContent =
        `Mission active - heading to WP ${state.next_wp + 1}/${state.waypoints.length}`;
    } else if (state.status === 'completed') {
      document.getElementById('roiInfo').textContent = 'Mission complete - vehicle returning to launch';
    }
  } else if (state.status === 'aborted') {
    clearWaypoints();
    drawRtlWaypoints([]);
    renderedMissionId = null;
  }
  updateMissionControls();
}

// ── Mission Commands ──────────────────────────────────────────────────────────
function startMission() {
  if (missionIsLocked()) {
    log('Resume or abort the saved mission first', 'warn');
    return;
  }
  if (roiPoints.length < 3) {
    log('Draw an ROI polygon first!', 'error');
    return;
  }
  const altitude = parseInt(document.getElementById('missionAlt').value);
  const spacing  = parseInt(document.getElementById('gridSpacing').value);
  const angle    = parseInt(document.getElementById('gridAngle').value);

  btnStartMission.disabled = true;
  document.getElementById('progressBar').style.width = '0%';

  socket.emit('start_mission', {
    polygon: roiPoints,
    altitude: altitude,
    spacing: spacing,
    angle: angle
  });

  log(`Mission started — alt: ${altitude}m, spacing: ${spacing}m, angle: ${angle}°`, 'success');
}

function resumeMission() {
  socket.emit('resume_mission');
  log('Resume mission requested', 'info');
}

function abortMission() {
  socket.emit('abort_mission');
  log('ABORT command sent - mission will be discarded', 'error');
}

function manualTakeoff() {
  const alt = parseInt(document.getElementById('manualAlt').value);
  socket.emit('manual_takeoff', { altitude: alt });
  log(`Manual takeoff → ${alt}m`, 'warn');
}

function manualRTL() {
  socket.emit('manual_rtl');
  log('RTL command sent', 'warn');
}

// ── Grid Preview (client-side, no drone needed) ───────────────────────────────
function clientGenerateGrid(polygon, spacingM) {
  const lats = polygon.map(p => p[0]);
  const lons = polygon.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const spacingLat = spacingM / 111000;
  const spacingLon = spacingM / (111000 * Math.cos(midLat * Math.PI / 180));

  function inPoly(lat, lon) {
    let inside = false, n = polygon.length, j = n - 1;
    for (let i = 0; i < n; i++) {
      const xi = polygon[i][1], yi = polygon[i][0];
      const xj = polygon[j][1], yj = polygon[j][0];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi))
        inside = !inside;
      j = i;
    }
    return inside;
  }

  const waypoints = [];
  let row = 0, curLat = minLat;
  while (curLat <= maxLat + spacingLat) {
    const rowPts = [];
    let curLon = minLon;
    const step = spacingLon / 8;
    while (curLon <= maxLon + step) {
      if (inPoly(curLat, curLon)) rowPts.push([curLat, curLon]);
      curLon += step;
    }
    if (rowPts.length) {
      const pts = row % 2 === 1 ? rowPts.reverse() : rowPts;
      waypoints.push(pts[0]);
      if (pts.length > 1) waypoints.push(pts[pts.length - 1]);
    }
    curLat += spacingLat;
    row++;
  }
  return waypoints;
}

function previewGrid() {
  if (roiPoints.length < 3) return;
  const spacing = parseInt(document.getElementById('gridSpacing').value) || 20;
  const waypoints = clientGenerateGrid(roiPoints, spacing);

  if (!waypoints.length) {
    log('No waypoints — try smaller spacing or larger ROI', 'warn');
    return;
  }

  // Draw preview (same style as live mission)
  drawWaypoints(waypoints.map(w => ({ lat: w[0], lon: w[1] })));
  log(`Grid preview: ${waypoints.length} waypoints at ${spacing}m spacing`, 'info');

  // Update ROI info
  const area = calculatePolygonArea(roiPoints);
  document.getElementById('roiInfo').textContent =
    `ROI: ${roiPoints.length} pts · ~${area.toFixed(0)}m² · ${waypoints.length} WPs`;
}

// ── Log Helper ────────────────────────────────────────────────────────────────
function log(msg, type = 'log') {
  const el = document.getElementById('statusLog');
  const ts  = new Date().toTimeString().slice(0,8);
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ── Grid Preview (angle slider) ───────────────────────────────────────────────
let angleDebounceTimer = null;

document.getElementById('gridAngle').addEventListener('input', function() {
  const angle = parseInt(this.value);
  document.getElementById('angleDisplay').textContent = angle;
  // Debounce: only send preview 150ms after user stops sliding
  clearTimeout(angleDebounceTimer);
  angleDebounceTimer = setTimeout(() => {
    if (roiPoints.length >= 3) {
      requestGridPreview();
    }
  }, 150);
});

function setAngle(deg) {
  document.getElementById('gridAngle').value = deg;
  document.getElementById('angleDisplay').textContent = deg;
  if (roiPoints.length >= 3) requestGridPreview();
}

function requestGridPreview() {
  socket.emit('preview_grid', {
    polygon: roiPoints,
    altitude: parseInt(document.getElementById('missionAlt').value),
    spacing: parseInt(document.getElementById('gridSpacing').value),
    angle: parseInt(document.getElementById('gridAngle').value)
  });
}

socket.on('grid_preview', (data) => {
  drawWaypoints(data.waypoints);
  const angle = data.angle;
  document.getElementById('roiInfo').textContent =
    `ROI ready · ${data.total_wp} waypoints · ${angle}° grid`;
});

// Also trigger preview when spacing changes
document.getElementById('gridSpacing').addEventListener('change', () => {
  if (roiPoints.length >= 3) requestGridPreview();
});

// ── Grid Preview (angle slider) end ───────────────────────────────────────────

btnDrawROI.addEventListener('click', startDrawing);
btnUndoPoint.addEventListener('click', undoDrawPoint);
btnFinishROI.addEventListener('click', () => finishDrawing());
document.getElementById('btnPreviewGrid').addEventListener('click', previewGrid);
document.getElementById('btnClearROI').addEventListener('click', clearROI);
document.getElementById('btnStartMission').addEventListener('click', startMission);
btnResumeMission.addEventListener('click', resumeMission);
document.getElementById('btnAbort').addEventListener('click', abortMission);
document.getElementById('btnManualTakeoff').addEventListener('click', manualTakeoff);
document.getElementById('btnManualRTL').addEventListener('click', manualRTL);
document.querySelectorAll('[data-angle-preset]').forEach((button) => {
  button.addEventListener('click', () => setAngle(parseInt(button.dataset.anglePreset)));
});
