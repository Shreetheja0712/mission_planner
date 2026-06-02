import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import appHtml from './app.html?raw';
import { createSocketBridge } from './socketBridge.js';
import { createMissionLayers } from './map/missionLayers.js';
import { createVehicleLayer } from './map/vehicleLayer.js';
import { createMissionStore } from './state/missionStore.js';
import { renderConnectionStatus, renderTelemetry } from './ui/telemetryPanel.js';

document.querySelector('#app').innerHTML = appHtml;

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = createSocketBridge();
let roiPolygon  = null;
let roiPoints = [];
let isDrawing = false;
let drawMarkers = [];
let drawPolyline = null;
let renderedMissionId = null;
let currentPreviewWaypoints = [];
let currentPreviewBatteryPrediction = null;
let pendingMissionPlan = null;
const mapHint = document.getElementById('mapHint');
const btnDrawROI = document.getElementById('btnDrawROI');
const drawActions = document.getElementById('drawActions');
const btnUndoPoint = document.getElementById('btnUndoPoint');
const btnFinishROI = document.getElementById('btnFinishROI');
const btnPreviewGrid = document.getElementById('btnPreviewGrid');
const btnExportPlan = document.getElementById('btnExportPlan');
const btnClearROI = document.getElementById('btnClearROI');
const btnStartMission = document.getElementById('btnStartMission');
const btnResumeMission = document.getElementById('btnResumeMission');
const btnMissionRTL = document.getElementById('btnMissionRTL');
const missionConfirm = document.getElementById('missionConfirm');
const btnCancelMissionConfirm = document.getElementById('btnCancelMissionConfirm');
const btnConfirmMissionStart = document.getElementById('btnConfirmMissionStart');
const missionStore = createMissionStore();

// ── Map Init ──────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [-35.363261, 149.165230],  // ArduPilot default SITL location (Canberra, AU)
  zoom: 17,
  maxZoom: 19,
  zoomControl: true,
  attributionControl: false
});
const missionLayers = createMissionLayers(map);
const vehicleLayer = createVehicleLayer(map, (lat, lon) => {
  log(`Home point set: ${lat.toFixed(6)}, ${lon.toFixed(6)}`, 'success');
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

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on('connect', () => log('Connected to backend', 'info'));
socket.on('disconnect', () => {
  missionStore.setConnected(false);
  renderConnectionStatus(false);
  log('Disconnected from backend', 'error');
});

socket.on('connection_status', (data) => {
  missionStore.setConnected(data.connected);
  renderConnectionStatus(data.connected);
  if (data.connected) log('Drone link established', 'success');
  else log(data.message || 'Drone not connected', 'warn');
});

socket.on('telemetry', (d) => {
  if (d.error) return;
  renderTelemetry(d);
  missionStore.setBatteryLevel(d.battery_level);
  vehicleLayer.update(d);
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

  if (d.battery_prediction) {
    renderMissionChecks(d.battery_prediction, 'live');
  }
});

socket.on('mission_state', applyMissionState);

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
  missionLayers.clearWaypoints();
  missionLayers.drawRtlWaypoints([]);

  roiPoints = [];
  currentPreviewWaypoints = [];
  currentPreviewBatteryPrediction = null;
  renderMissionChecks(null);
  closeMissionConfirm();
  document.getElementById('roiInfo').textContent = 'No ROI defined — draw on map';
  btnStartMission.disabled = true;
  btnPreviewGrid.disabled = true;
  btnExportPlan.disabled = true;
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
function drawWaypoints(waypoints, shouldLog = true) {
  missionLayers.drawWaypoints(waypoints);
  if (shouldLog) log(`Grid path drawn: ${waypoints.length} waypoints`, 'info');
}

function missionIsLocked() {
  return missionStore.isLocked();
}

function updateMissionControls() {
  const locked = missionIsLocked();
  const paused = missionStore.getMission().status === 'paused';

  btnDrawROI.disabled = isDrawing || locked;
  btnClearROI.disabled = locked;
  btnPreviewGrid.disabled = locked || roiPoints.length < 3;
  btnExportPlan.disabled = locked || currentPreviewWaypoints.length === 0;
  btnStartMission.disabled = locked || roiPoints.length < 3;
  btnResumeMission.hidden = !paused;
  btnResumeMission.disabled = !missionStore.canResume();

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
  missionLayers.drawRtlWaypoints(state.rtl_waypoints || []);

  if (state.id && renderedMissionId !== state.id && roiPolygon) {
    map.fitBounds(roiPolygon.getBounds(), { padding: [40, 40] });
    renderedMissionId = state.id;
  }
}

function applyMissionState(state) {
  if (state.status === 'running' || state.status === 'paused' || state.status === 'completed') {
    restoreMissionMap(state);
    document.getElementById('progressBar').style.width = `${state.progress || 0}%`;
    if (state.status === 'paused') {
      renderMissionChecks(state.battery_prediction, 'paused');
      const latest = (state.rtl_waypoints || []).length;
      document.getElementById('roiInfo').textContent =
        latest > 0
          ? `Mission paused - RTL WP ${latest} saved - recharge and resume`
          : 'Mission paused - recharge and resume pending grid route';
    } else if (state.status === 'running') {
      renderMissionChecks(state.battery_prediction, 'live');
      const batteryText = formatBatteryPrediction(state.battery_prediction);
      document.getElementById('roiInfo').textContent =
        `Mission active - heading to WP ${state.next_wp + 1}/${state.waypoints.length}${batteryText}`;
    } else if (state.status === 'completed') {
      renderMissionChecks(state.battery_prediction, 'completed');
      document.getElementById('roiInfo').textContent = 'Mission complete - vehicle returning to launch';
    }
  } else if (state.status === 'aborted') {
    missionLayers.clearWaypoints();
    missionLayers.drawRtlWaypoints([]);
    renderedMissionId = null;
    renderMissionChecks(null);
  }
  missionStore.setMission(state);
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

  if (currentPreviewWaypoints.length === 0) {
    requestGridPreview();
    log('Preview the grid before starting so battery prediction can be checked', 'warn');
    return;
  }

  pendingMissionPlan = {
    polygon: roiPoints.map(point => [...point]),
    altitude,
    spacing,
    angle,
    waypoints: currentPreviewWaypoints,
    batteryPrediction: currentPreviewBatteryPrediction,
  };
  openMissionConfirm(pendingMissionPlan);
}

function confirmMissionStart() {
  if (!pendingMissionPlan) return;

  const plan = pendingMissionPlan;
  btnStartMission.disabled = true;
  document.getElementById('progressBar').style.width = '0%';
  closeMissionConfirm();

  socket.emit('start_mission', {
    polygon: plan.polygon,
    altitude: plan.altitude,
    spacing: plan.spacing,
    angle: plan.angle,
  });

  log(
    `Mission started - alt: ${plan.altitude}m, spacing: ${plan.spacing}m, angle: ${plan.angle} deg`,
    'success'
  );
  pendingMissionPlan = null;
}

function resumeMission() {
  socket.emit('resume_mission');
  log('Resume mission requested', 'info');
}

function abortMission() {
  socket.emit('abort_mission');
  log('ABORT command sent - mission will be discarded', 'error');
}

function missionRTL() {
  socket.emit('manual_rtl');
  log(missionStore.getMission().status === 'running'
    ? 'RTL requested - mission will pause for resume'
    : 'RTL command sent', 'warn');
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
  requestGridPreview();
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
  currentPreviewWaypoints = [];
  currentPreviewBatteryPrediction = null;
  renderMissionChecks(null, 'loading');
  btnExportPlan.disabled = true;
  socket.emit('preview_grid', {
    polygon: roiPoints,
    altitude: parseInt(document.getElementById('missionAlt').value),
    spacing: parseInt(document.getElementById('gridSpacing').value),
    angle: parseInt(document.getElementById('gridAngle').value)
  });
}

socket.on('grid_preview', (data) => {
  currentPreviewWaypoints = data.waypoints;
  currentPreviewBatteryPrediction = data.battery_prediction || null;
  renderMissionChecks(currentPreviewBatteryPrediction, 'preview');
  btnExportPlan.disabled = currentPreviewWaypoints.length === 0;
  drawWaypoints(data.waypoints);
  const angle = data.angle;
  const batteryText = formatBatteryPrediction(data.battery_prediction);
  document.getElementById('roiInfo').textContent =
    `ROI ready - ${data.total_wp} waypoints - ${angle} deg grid${batteryText}`;
});

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`
    : `${remainingSeconds}s`;
}

function formatDistance(meters) {
  const distance = Number(meters || 0);
  return distance >= 1000
    ? `${(distance / 1000).toFixed(2)} km`
    : `${Math.round(distance)} m`;
}

function renderMissionChecks(prediction, phase = 'idle') {
  const status = document.getElementById('missionCheckStatus');
  const time = document.getElementById('missionCheckTime');
  const distance = document.getElementById('missionCheckDistance');
  const required = document.getElementById('missionCheckRequired');
  const projected = document.getElementById('missionCheckProjected');

  status.classList.remove('safe', 'warn', 'unknown');

  if (!prediction) {
    time.textContent = '--';
    distance.textContent = '--';
    required.textContent = '--';
    projected.textContent = '--';
    status.classList.add('unknown');
    status.querySelector('span:last-child').textContent =
      phase === 'loading' ? 'Checking mission battery...' : 'No mission prediction yet';
    return;
  }

  const batteryAfter = prediction.projected_battery_pct;
  const reserve = prediction.reserve_battery_pct;

  time.textContent = formatDuration(prediction.flight_time_s);
  distance.textContent = formatDistance(prediction.distance_m);
  required.textContent = `${prediction.battery_required_pct}%`;
  projected.textContent =
    batteryAfter === null || batteryAfter === undefined ? 'Unknown' : `${batteryAfter}%`;

  if (prediction.safe) {
    status.classList.add('safe');
    status.querySelector('span:last-child').textContent =
      phase === 'preview'
        ? `Check passed: reserve stays above ${reserve}%`
        : `Battery prediction OK: reserve above ${reserve}%`;
  } else {
    status.classList.add('warn');
    status.querySelector('span:last-child').textContent =
      `Low reserve: projected battery below ${reserve}%`;
  }
}

function openMissionConfirm(plan) {
  const prediction = plan.batteryPrediction;
  document.getElementById('confirmRoiPoints').textContent = plan.polygon.length;
  document.getElementById('confirmWaypoints').textContent = plan.waypoints.length;
  document.getElementById('confirmAltitude').textContent = `${plan.altitude} m`;
  document.getElementById('confirmSpacing').textContent = `${plan.spacing} m`;
  document.getElementById('confirmAngle').textContent = `${plan.angle} deg`;
  document.getElementById('confirmTime').textContent = prediction
    ? formatDuration(prediction.flight_time_s)
    : '--';
  document.getElementById('confirmDistance').textContent = prediction
    ? formatDistance(prediction.distance_m)
    : '--';

  const batteryAfter = prediction?.projected_battery_pct;
  document.getElementById('confirmBattery').textContent =
    batteryAfter === null || batteryAfter === undefined ? 'Unknown' : `${batteryAfter}%`;

  const warning = document.getElementById('confirmWarning');
  if (!prediction) {
    warning.textContent = 'Battery prediction is unavailable for this preview.';
    warning.hidden = false;
  } else if (!prediction.safe) {
    warning.textContent =
      `Low reserve: projected battery is below ${prediction.reserve_battery_pct}% after this route.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  missionConfirm.hidden = false;
  btnConfirmMissionStart.focus();
}

function closeMissionConfirm() {
  missionConfirm.hidden = true;
}

function formatBatteryPrediction(prediction) {
  if (!prediction) return '';
  const minutes = Math.ceil((prediction.flight_time_s || 0) / 60);
  const projected = prediction.projected_battery_pct;
  const reserve = prediction.reserve_battery_pct;
  const suffix = projected === null || projected === undefined
    ? ` - est ${minutes} min`
    : ` - est ${minutes} min - battery ${projected}% after`;
  return prediction.safe ? suffix : `${suffix} - LOW RESERVE (<${reserve}%)`;
}

function exportMissionPlan() {
  if (currentPreviewWaypoints.length === 0) return;
  
  const alt = parseInt(document.getElementById('missionAlt').value);
  let wpText = "QGC WPL 110\n";
  
  // Waypoint 0 (Home Placeholder)
  wpText += `0\t1\t0\t16\t0\t0\t0\t0\t${currentPreviewWaypoints[0].lat.toFixed(7)}\t${currentPreviewWaypoints[0].lon.toFixed(7)}\t${alt}\t1\n`;
  
  currentPreviewWaypoints.forEach((wp, index) => {
    // 16 = MAV_CMD_NAV_WAYPOINT, Frame 3 = Global Relative Alt
    wpText += `${index + 1}\t0\t3\t16\t0\t0\t0\t0\t${wp.lat.toFixed(7)}\t${wp.lon.toFixed(7)}\t${alt}\t1\n`;
  });
  
  const blob = new Blob([wpText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement("a");
  a.href = url;
  a.download = `GridSearch_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.waypoints`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  log(`Exported plan with ${currentPreviewWaypoints.length} waypoints`, 'success');
}

// Also trigger preview when spacing changes
document.getElementById('gridSpacing').addEventListener('change', () => {
  if (roiPoints.length >= 3) requestGridPreview();
});

document.getElementById('missionAlt').addEventListener('change', () => {
  if (roiPoints.length >= 3) requestGridPreview();
});

// ── Grid Preview (angle slider) end ───────────────────────────────────────────

btnDrawROI.addEventListener('click', startDrawing);
btnUndoPoint.addEventListener('click', undoDrawPoint);
btnFinishROI.addEventListener('click', () => finishDrawing());
btnPreviewGrid.addEventListener('click', previewGrid);
btnExportPlan.addEventListener('click', exportMissionPlan);
document.getElementById('btnClearROI').addEventListener('click', clearROI);
document.getElementById('btnStartMission').addEventListener('click', startMission);
btnResumeMission.addEventListener('click', resumeMission);
btnMissionRTL.addEventListener('click', missionRTL);
btnCancelMissionConfirm.addEventListener('click', closeMissionConfirm);
btnConfirmMissionStart.addEventListener('click', confirmMissionStart);
missionConfirm.addEventListener('click', (event) => {
  if (event.target === missionConfirm) closeMissionConfirm();
});
document.getElementById('btnAbort').addEventListener('click', abortMission);
document.getElementById('btnManualTakeoff').addEventListener('click', manualTakeoff);
document.getElementById('btnManualRTL').addEventListener('click', manualRTL);
document.querySelectorAll('[data-angle-preset]').forEach((button) => {
  button.addEventListener('click', () => setAngle(parseInt(button.dataset.anglePreset)));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !missionConfirm.hidden) closeMissionConfirm();
});

missionStore.subscribe(updateMissionControls);
