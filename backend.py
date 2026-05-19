#!/usr/bin/env python3
"""
SAR Drone Dashboard Backend
Pure pymavlink — Python 3.12 compatible, eventlet-safe
Supports rotated grid search angle
"""

import math
import time
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template
from flask_socketio import SocketIO, emit
from pymavlink import mavutil

app = Flask(__name__, template_folder='.')
app.config['SECRET_KEY'] = 'sar_drone_2024'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# ── Global State ───────────────────────────────────────────────────────────────
vehicle      = None
stop_mission = False

telemetry = {
    'lat': 0, 'lon': 0, 'alt': 0,
    'heading': 0, 'groundspeed': 0, 'airspeed': 0,
    'battery_voltage': 0, 'battery_level': 0,
    'mode': '--', 'armed': False,
    'gps_fix': 0, 'satellites': 0,
}

MODE_MAP = {
    0:'STABILIZE', 1:'ACRO', 2:'ALT_HOLD', 3:'AUTO', 4:'GUIDED',
    5:'LOITER', 6:'RTL', 7:'CIRCLE', 9:'LAND', 11:'DRIFT',
    13:'SPORT', 16:'POSHOLD', 17:'BRAKE', 21:'SMART_RTL',
}

# ── MAVLink Connection ─────────────────────────────────────────────────────────
def connect_vehicle():
    global vehicle
    print("[SAR] Connecting to SITL on udp:127.0.0.1:14550 ...")
    try:
        vehicle = mavutil.mavlink_connection('udpin:127.0.0.1:14550')
        vehicle.wait_heartbeat(timeout=30)
        print(f"[SAR] Heartbeat — system {vehicle.target_system}, component {vehicle.target_component}")
        vehicle.mav.request_data_stream_send(
            vehicle.target_system, vehicle.target_component,
            mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1
        )
        return True
    except Exception as e:
        print(f"[SAR] Connection failed: {e}")
        return False

# ── Telemetry Loop ─────────────────────────────────────────────────────────────
def telemetry_loop():
    last_emit = 0
    while True:
        if vehicle:
            try:
                while True:
                    msg = vehicle.recv_match(blocking=False)
                    if msg is None:
                        break
                    mt = msg.get_type()
                    if mt == 'GLOBAL_POSITION_INT':
                        telemetry['lat']     = msg.lat / 1e7
                        telemetry['lon']     = msg.lon / 1e7
                        telemetry['alt']     = round(msg.relative_alt / 1000.0, 1)
                        telemetry['heading'] = round(msg.hdg / 100.0, 1) if msg.hdg != 65535 else 0
                    elif mt == 'VFR_HUD':
                        telemetry['groundspeed'] = round(msg.groundspeed, 1)
                        telemetry['airspeed']    = round(msg.airspeed, 1)
                    elif mt == 'SYS_STATUS':
                        telemetry['battery_voltage'] = round(msg.voltage_battery / 1000.0, 2)
                        telemetry['battery_level']   = msg.battery_remaining
                    elif mt == 'GPS_RAW_INT':
                        telemetry['gps_fix']    = msg.fix_type
                        telemetry['satellites'] = msg.satellites_visible
                    elif mt == 'HEARTBEAT' and msg.get_srcComponent() == 1:
                        telemetry['mode']  = MODE_MAP.get(msg.custom_mode, f'MODE_{msg.custom_mode}')
                        telemetry['armed'] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)

                now = time.time()
                if now - last_emit >= 0.25:
                    socketio.emit('telemetry', telemetry)
                    last_emit = now
            except Exception as e:
                print(f"[SAR] Telemetry error: {e}")
        eventlet.sleep(0.05)

# ── MAVLink Helpers ────────────────────────────────────────────────────────────
def set_mode(mode_name):
    mode_id = next((k for k, v in MODE_MAP.items() if v == mode_name), None)
    if mode_id is None:
        return
    vehicle.mav.set_mode_send(
        vehicle.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode_id
    )

def arm_vehicle():
    vehicle.mav.command_long_send(
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0, 1, 21196, 0, 0, 0, 0, 0
    )

def takeoff_cmd(altitude):
    vehicle.mav.command_long_send(
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0, 0, 0, 0, 0, 0, 0, float(altitude)
    )

def goto(lat, lon, alt):
    vehicle.mav.send(mavutil.mavlink.MAVLink_set_position_target_global_int_message(
        0,
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        int(0b110111111000),
        int(lat * 1e7), int(lon * 1e7), int(alt),
        0, 0, 0, 0, 0, 0, 0, 0
    ))

def get_distance_m(lat1, lon1, lat2, lon2):
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    return math.sqrt(dlat**2 + dlon**2) * 1.113195e5

def wait_for_condition(condition_fn, timeout=30, interval=0.3):
    elapsed = 0
    while elapsed < timeout:
        if stop_mission:
            return False
        if condition_fn():
            return True
        eventlet.sleep(interval)
        elapsed += interval
    return False

# ── Rotated Grid Generation ────────────────────────────────────────────────────

def latlon_to_xy(lat, lon, origin_lat, origin_lon):
    """Convert lat/lon to local XY metres relative to origin."""
    x = (lon - origin_lon) * 111000.0 * math.cos(math.radians(origin_lat))
    y = (lat - origin_lat) * 111000.0
    return x, y

def xy_to_latlon(x, y, origin_lat, origin_lon):
    """Convert local XY metres back to lat/lon."""
    lat = origin_lat + y / 111000.0
    lon = origin_lon + x / (111000.0 * math.cos(math.radians(origin_lat)))
    return lat, lon

def rotate_point(x, y, angle_rad):
    """Rotate point by angle_rad around origin."""
    rx = x * math.cos(angle_rad) - y * math.sin(angle_rad)
    ry = x * math.sin(angle_rad) + y * math.cos(angle_rad)
    return rx, ry

def point_in_polygon_xy(px, py, polygon_xy):
    """Ray casting in XY space."""
    n = len(polygon_xy)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon_xy[i]
        xj, yj = polygon_xy[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def generate_grid_waypoints(polygon, altitude, spacing_m=20, angle_deg=0):
    """
    Generate lawnmower grid waypoints inside polygon.
    angle_deg: rotation of scan lines (0 = horizontal, 90 = vertical)
    """
    if len(polygon) < 3:
        return []

    # Centroid as local origin
    origin_lat = sum(p[0] for p in polygon) / len(polygon)
    origin_lon = sum(p[1] for p in polygon) / len(polygon)

    # Convert polygon to XY
    poly_xy = [latlon_to_xy(p[0], p[1], origin_lat, origin_lon) for p in polygon]

    # Rotate polygon by -angle to align grid with axes
    angle_rad = math.radians(angle_deg)
    poly_rot = [rotate_point(x, y, -angle_rad) for x, y in poly_xy]

    # Bounding box in rotated frame
    xs = [p[0] for p in poly_rot]
    ys = [p[1] for p in poly_rot]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    # Generate horizontal scan lines in rotated frame
    waypoints_rot = []
    current_y = min_y
    row = 0

    while current_y <= max_y + spacing_m:
        row_points = []
        step = spacing_m / 8.0
        current_x = min_x
        while current_x <= max_x + step:
            if point_in_polygon_xy(current_x, current_y, poly_rot):
                row_points.append((current_x, current_y))
            current_x += step

        if row_points:
            if row % 2 == 1:
                row_points = row_points[::-1]
            waypoints_rot.append(row_points[0])
            if len(row_points) > 1:
                waypoints_rot.append(row_points[-1])

        current_y += spacing_m
        row += 1

    # Rotate waypoints back and convert to lat/lon
    waypoints = []
    for (rx, ry) in waypoints_rot:
        x, y = rotate_point(rx, ry, angle_rad)
        lat, lon = xy_to_latlon(x, y, origin_lat, origin_lon)
        waypoints.append((lat, lon, altitude))

    return waypoints

# ── Mission Execution ──────────────────────────────────────────────────────────
def execute_grid_mission(polygon, altitude, spacing, angle_deg):
    global stop_mission
    stop_mission = False

    def status(msg, **kwargs):
        data = {'status': msg}
        data.update(kwargs)
        socketio.emit('mission_status', data)
        print(f"[MISSION] {msg}")

    try:
        status('Setting GUIDED mode...')
        set_mode('GUIDED')
        eventlet.sleep(2)

        status('Arming motors...')
        arm_vehicle()
        armed = wait_for_condition(lambda: telemetry['armed'], timeout=15)
        if not armed:
            status('Failed to arm! In SITL console type: arm throttle', error=True)
            return

        status('Armed! Taking off...')
        eventlet.sleep(1)
        takeoff_cmd(altitude)

        reached = wait_for_condition(lambda: telemetry['alt'] >= altitude * 0.90, timeout=40)
        if not reached:
            status(f'Takeoff timeout at {telemetry["alt"]}m', error=True)
            return

        status(f'At {telemetry["alt"]}m. Generating {angle_deg}° grid...')
        eventlet.sleep(1)

        waypoints = generate_grid_waypoints(polygon, altitude, spacing, angle_deg)
        total = len(waypoints)

        if not waypoints:
            status('No waypoints — try larger ROI or smaller spacing', error=True)
            return

        status(
            f'Grid ready: {total} waypoints at {angle_deg}°',
            waypoints=[{'lat': w[0], 'lon': w[1]} for w in waypoints],
            total_wp=total
        )
        eventlet.sleep(1)

        for i, wp in enumerate(waypoints):
            if stop_mission:
                break
            goto(wp[0], wp[1], wp[2])
            pct = int(((i + 1) / total) * 100)
            status(
                f'Grid search: waypoint {i+1}/{total}',
                current_wp=i,
                total_wp=total,
                progress=pct,
                current_target={'lat': wp[0], 'lon': wp[1]}
            )
            wait_for_condition(
                lambda: get_distance_m(telemetry['lat'], telemetry['lon'], wp[0], wp[1]) < 8.0,
                timeout=60
            )

        if stop_mission:
            status('Mission aborted by operator', aborted=True)
        else:
            status('Grid complete! Returning to launch...', progress=100)

        set_mode('RTL')
        eventlet.sleep(1)
        status('RTL active. Mission complete!', complete=True)

    except Exception as e:
        socketio.emit('mission_status', {'status': f'Mission error: {str(e)}', 'error': True})
        import traceback; traceback.print_exc()

# ── SocketIO Events ────────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    print('[SAR] Browser connected')
    emit('connection_status', {'connected': vehicle is not None})

@socketio.on('start_mission')
def on_start_mission(data):
    global stop_mission
    polygon   = data.get('polygon', [])
    altitude  = float(data.get('altitude', 20))
    spacing   = float(data.get('spacing', 20))
    angle_deg = float(data.get('angle', 0))

    if len(polygon) < 3:
        emit('mission_status', {'status': 'Need at least 3 ROI points', 'error': True})
        return

    stop_mission = False
    socketio.start_background_task(execute_grid_mission, polygon, altitude, spacing, angle_deg)
    emit('mission_status', {'status': f'Mission queued — alt:{altitude}m spacing:{spacing}m angle:{angle_deg}°'})

@socketio.on('preview_grid')
def on_preview_grid(data):
    """Generate and send grid preview without flying — for the angle slider."""
    polygon   = data.get('polygon', [])
    altitude  = float(data.get('altitude', 20))
    spacing   = float(data.get('spacing', 20))
    angle_deg = float(data.get('angle', 0))

    if len(polygon) < 3:
        return

    waypoints = generate_grid_waypoints(polygon, altitude, spacing, angle_deg)
    emit('grid_preview', {
        'waypoints': [{'lat': w[0], 'lon': w[1]} for w in waypoints],
        'total_wp': len(waypoints),
        'angle': angle_deg
    })

@socketio.on('abort_mission')
def on_abort_mission():
    global stop_mission
    stop_mission = True
    if vehicle:
        set_mode('RTL')
    emit('mission_status', {'status': 'ABORT — RTL activated', 'aborted': True})

@socketio.on('manual_takeoff')
def on_manual_takeoff(data):
    alt = float(data.get('altitude', 10))
    set_mode('GUIDED')
    eventlet.sleep(1)
    arm_vehicle()
    eventlet.sleep(3)
    takeoff_cmd(alt)
    emit('mission_status', {'status': f'Manual takeoff → {alt}m'})

@socketio.on('manual_rtl')
def on_manual_rtl():
    set_mode('RTL')
    emit('mission_status', {'status': 'RTL activated'})

# ── Flask ──────────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

# ── Main ───────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print("=" * 50)
    print("  SAR Drone Dashboard — pymavlink backend")
    print("=" * 50)
    if connect_vehicle():
        socketio.start_background_task(telemetry_loop)
        print("[SAR] Telemetry greenlet started")
        print("[SAR] Dashboard → http://localhost:5000")
        socketio.run(app, host='0.0.0.0', port=5000, debug=False)
    else:
        print("[SAR] Could not connect. Is sim_vehicle.py running?")
