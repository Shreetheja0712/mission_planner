import L from 'leaflet';

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

export function createVehicleLayer(map, onHomeSet) {
  let droneMarker = null;
  let homeSet = false;

  function update(telemetry) {
    if (!telemetry.lat || !telemetry.lon || telemetry.lat === 0) return;

    const position = [telemetry.lat, telemetry.lon];
    if (!homeSet && telemetry.gps_fix >= 3) {
      homeSet = true;
      const homeMarker = L.marker(position, {
        icon: makeHomeIcon(),
        zIndexOffset: 500
      }).addTo(map);
      homeMarker.bindTooltip('Home / Launch Point', {
        permanent: false,
        direction: 'top',
        className: 'leaflet-tooltip-dark'
      });
      onHomeSet?.(telemetry.lat, telemetry.lon);
    }

    if (!droneMarker) {
      droneMarker = L.marker(position, {
        icon: makeDroneIcon(telemetry.heading),
        zIndexOffset: 1000
      }).addTo(map);
      map.setView(position, 17);
    } else {
      droneMarker.setLatLng(position);
      droneMarker.setIcon(makeDroneIcon(telemetry.heading));
    }
  }

  return { update };
}
