import asyncio
import json
import time
from pymavlink import mavutil
from core.config import settings
from drone.telemetry_queue import telemetry, connected_clients

vehicle = None
vehicle_connected = False
last_heartbeat = None
HEARTBEAT_TIMEOUT_SECONDS = 5.0

MODE_MAP = {
    0:'STABILIZE', 1:'ACRO', 2:'ALT_HOLD', 3:'AUTO', 4:'GUIDED',
    5:'LOITER', 6:'RTL', 7:'CIRCLE', 9:'LAND', 11:'DRIFT',
    13:'SPORT', 16:'POSHOLD', 17:'BRAKE', 21:'SMART_RTL',
}

async def connect_vehicle():
    global vehicle, vehicle_connected, last_heartbeat
    print(f"[SAR] Connecting to SITL on {settings.MAVLINK_URL} ...")
    try:
        # Run the blocking connection in a thread
        vehicle = await asyncio.to_thread(mavutil.mavlink_connection, settings.MAVLINK_URL)
        await asyncio.to_thread(vehicle.wait_heartbeat, timeout=30)
        vehicle_connected = True
        last_heartbeat = time.monotonic()
        print(f"[SAR] Heartbeat — system {vehicle.target_system}, component {vehicle.target_component}")
        request_data_stream()
        return True
    except Exception as e:
        vehicle_connected = False
        print(f"[SAR] Connection failed: {e}")
        return False

def request_data_stream():
    if not vehicle:
        return
    vehicle.mav.request_data_stream_send(
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1
    )

def is_vehicle_connected():
    return vehicle_connected

async def emit_connection_status(connected, message=None):
    if not connected_clients:
        return
    data = {"connected": connected}
    if message:
        data["message"] = message
    payload = json.dumps({"type": "connection_status", "data": data})
    for client in list(connected_clients):
        try:
            await client.send_text(payload)
        except Exception:
            connected_clients.discard(client)

async def emit_telemetry_to_clients():
    if not connected_clients:
        return
    data = json.dumps({"type": "telemetry", "data": telemetry})
    to_remove = set()
    for client in connected_clients:
        try:
            await client.send_text(data)
        except Exception:
            to_remove.add(client)
    for c in to_remove:
        connected_clients.remove(c)

async def handle_message(msg):
    global vehicle_connected, last_heartbeat
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
        was_connected = vehicle_connected
        vehicle_connected = True
        last_heartbeat = time.monotonic()
        telemetry['mode']  = MODE_MAP.get(msg.custom_mode, f'MODE_{msg.custom_mode}')
        telemetry['armed'] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
        if not was_connected:
            print('[SAR] Vehicle heartbeat restored')
            request_data_stream()
            await emit_connection_status(True)

async def check_heartbeat_timeout():
    global vehicle_connected
    if (
        vehicle_connected
        and last_heartbeat is not None
        and time.monotonic() - last_heartbeat > HEARTBEAT_TIMEOUT_SECONDS
    ):
        vehicle_connected = False
        telemetry['mode'] = '--'
        telemetry['armed'] = False
        print('[SAR] Vehicle heartbeat lost')
        await emit_connection_status(False, 'Vehicle heartbeat lost')
        return True
    return False

async def telemetry_loop():
    last_emit = 0
    while True:
        if vehicle:
            try:
                while True:
                    msg = vehicle.recv_match(blocking=False)
                    if msg is None:
                        break
                    await handle_message(msg)

                now = time.time()
                await check_heartbeat_timeout()
                if now - last_emit >= 0.25:
                    await emit_telemetry_to_clients()
                    last_emit = now
            except Exception as e:
                print(f"[SAR] Telemetry error: {e}")
        
        await asyncio.sleep(0.05)

def set_mode(mode_name):
    if not vehicle: return
    mode_id = next((k for k, v in MODE_MAP.items() if v == mode_name), None)
    if mode_id is None: return
    vehicle.mav.set_mode_send(
        vehicle.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode_id
    )

def arm_vehicle():
    if not vehicle: return
    vehicle.mav.command_long_send(
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0, 1, 21196, 0, 0, 0, 0, 0
    )

def takeoff_cmd(altitude):
    if not vehicle: return
    vehicle.mav.command_long_send(
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0, 0, 0, 0, 0, 0, 0, float(altitude)
    )

def goto(lat, lon, alt):
    if not vehicle: return
    vehicle.mav.send(mavutil.mavlink.MAVLink_set_position_target_global_int_message(
        0,
        vehicle.target_system, vehicle.target_component,
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        int(0b110111111000),
        int(lat * 1e7), int(lon * 1e7), int(alt),
        0, 0, 0, 0, 0, 0, 0, 0
    ))
