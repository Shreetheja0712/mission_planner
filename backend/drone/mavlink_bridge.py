import asyncio
import time
from pymavlink import mavutil
from core.config import settings
from drone.telemetry_queue import telemetry, connected_clients
from algorithms.navigation import generate_grid_waypoints

vehicle = None

MODE_MAP = {
    0:'STABILIZE', 1:'ACRO', 2:'ALT_HOLD', 3:'AUTO', 4:'GUIDED',
    5:'LOITER', 6:'RTL', 7:'CIRCLE', 9:'LAND', 11:'DRIFT',
    13:'SPORT', 16:'POSHOLD', 17:'BRAKE', 21:'SMART_RTL',
}

async def connect_vehicle():
    global vehicle
    print(f"Connecting to MAVLink on {settings.MAVLINK_URL}...")
    try:
        # Run the blocking connection in a thread
        vehicle = await asyncio.to_thread(mavutil.mavlink_connection, settings.MAVLINK_URL)
        await asyncio.to_thread(vehicle.wait_heartbeat, timeout=30)
        print(f"Heartbeat — system {vehicle.target_system}, component {vehicle.target_component}")
        vehicle.mav.request_data_stream_send(
            vehicle.target_system, vehicle.target_component,
            mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1
        )
        return True
    except Exception as e:
        print(f"Connection failed: {e}")
        return False

async def emit_telemetry_to_clients():
    import json
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

async def telemetry_loop():
    last_emit = 0
    while True:
        if vehicle:
            try:
                # Read all available messages up to a limit so we don't block forever
                for _ in range(50): 
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
                # Broadcast at ~4 Hz (every 0.25s) just like your old app, 
                # or reduce to 0.1 for 10Hz.
                if now - last_emit >= 0.25:
                    await emit_telemetry_to_clients()
                    last_emit = now
            except Exception as e:
                print(f"Telemetry error: {e}")
        
        # Yield back to the event loop so FastAPI can process requests
        await asyncio.sleep(0.01)

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
