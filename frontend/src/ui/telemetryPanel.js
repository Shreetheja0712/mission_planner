export function renderConnectionStatus(online) {
  document.getElementById('connDot').classList.toggle('online', online);
  document.getElementById('connText').textContent = online ? 'DRONE ONLINE' : 'DISCONNECTED';
}

export function renderTelemetry(data) {
  document.getElementById('modeBadge').textContent = data.mode || '--';
  const armedBadge = document.getElementById('armedBadge');
  armedBadge.textContent = data.armed ? 'ARMED' : 'DISARMED';
  armedBadge.classList.toggle('armed', data.armed);

  document.getElementById('tAlt').innerHTML = `${data.alt}<span class="telem-unit">m</span>`;
  document.getElementById('tHdg').innerHTML = `${data.heading}<span class="telem-unit">°</span>`;
  document.getElementById('tSpd').innerHTML = `${data.groundspeed}<span class="telem-unit">m/s</span>`;
  document.getElementById('tVolt').innerHTML = `${data.battery_voltage}<span class="telem-unit">V</span>`;

  const battery = data.battery_level || 0;
  document.getElementById('tBattPct').textContent = `${battery}%`;
  const bar = document.getElementById('battBar');
  bar.style.width = `${battery}%`;
  bar.style.background = battery > 50
    ? 'var(--green)'
    : battery > 20 ? 'var(--yellow)' : 'var(--red)';

  const hasFix = data.gps_fix >= 3;
  document.getElementById('gpsDot').classList.toggle('fix', hasFix);
  document.getElementById('gpsText').textContent = hasFix
    ? `Fix ${data.gps_fix} · ${data.satellites} sats`
    : 'No Fix';

  if (data.lat && data.lon && data.lat !== 0) {
    document.getElementById('coordDisplay').textContent =
      `${data.lat.toFixed(6)}°, ${data.lon.toFixed(6)}°`;
  }
}
