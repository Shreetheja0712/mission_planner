import L from 'leaflet';

export function createMissionLayers(map) {
  let waypointMarkers = [];
  let currentWpLine = null;
  let rtlWaypointMarkers = [];

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
      html: `<span class="rtl-waypoint-marker-label">R${number}</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function drawWaypoints(waypoints) {
    clearWaypoints();

    currentWpLine = L.polyline(waypoints.map(wp => [wp.lat, wp.lon]), {
      color: '#ff6b35',
      weight: 1.5,
      opacity: 0.8,
      dashArray: '4,4'
    }).addTo(map);

    waypoints.forEach((wp, index) => {
      const marker = L.marker([wp.lat, wp.lon], {
        icon: makeWaypointIcon(index + 1, index === 0),
        interactive: false,
        keyboard: false,
        zIndexOffset: 200
      }).addTo(map);
      waypointMarkers.push(marker);
    });
  }

  function clearWaypoints() {
    waypointMarkers.forEach(marker => map.removeLayer(marker));
    waypointMarkers = [];
    if (currentWpLine) {
      map.removeLayer(currentWpLine);
      currentWpLine = null;
    }
  }

  function drawRtlWaypoints(waypoints) {
    rtlWaypointMarkers.forEach(marker => map.removeLayer(marker));
    rtlWaypointMarkers = [];

    waypoints.forEach((wp, index) => {
      const marker = L.marker([wp.lat, wp.lon], {
        icon: makeRtlWaypointIcon(wp.number || index + 1),
        interactive: false,
        keyboard: false,
        zIndexOffset: 350
      }).addTo(map);
      rtlWaypointMarkers.push(marker);
    });
  }

  return {
    clearWaypoints,
    drawRtlWaypoints,
    drawWaypoints
  };
}
