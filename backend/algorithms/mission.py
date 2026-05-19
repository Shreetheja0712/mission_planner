import asyncio
import time
import math
import json
from drone.mavlink_bridge import set_mode, arm_vehicle, takeoff_cmd, goto, vehicle
from drone.telemetry_queue import telemetry, connected_clients
from algorithms.navigation import generate_grid_waypoints

stop_mission = False

async def emit_ws(msg_type, data):
    payload = json.dumps({"type": msg_type, "data": data})
    for client in list(connected_clients):
        try:
            await client.send_text(payload)
        except Exception:
            pass

async def emit_status(msg, **kwargs):
    data = {'status': msg}
    data.update(kwargs)
    await emit_ws('mission_status', data)
    print(f"[MISSION] {msg}")

def get_distance_m(lat1, lon1, lat2, lon2):
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    return math.sqrt(dlat**2 + dlon**2) * 1.113195e5

async def wait_for_condition(condition_fn, timeout=30, interval=0.5):
    global stop_mission
    elapsed = 0
    while elapsed < timeout:
        if stop_mission:
            return False
        if condition_fn():
            return True
        await asyncio.sleep(interval)
        elapsed += interval
    return False

async def execute_grid_mission(polygon, altitude, spacing, angle_deg):
    global stop_mission
    stop_mission = False

    try:
        await emit_status('Setting GUIDED mode...')
        set_mode('GUIDED')
        await asyncio.sleep(2)

        await emit_status('Arming motors...')
        arm_vehicle()
        armed = await wait_for_condition(lambda: telemetry['armed'], timeout=15)
        if not armed:
            await emit_status('Failed to arm!', error=True)
            return

        await emit_status('Armed! Taking off...')
        await asyncio.sleep(1)
        takeoff_cmd(altitude)

        reached = await wait_for_condition(lambda: telemetry['alt'] >= altitude * 0.90, timeout=40)
        if not reached:
            await emit_status(f'Takeoff timeout at {telemetry["alt"]}m', error=True)
            return

        await emit_status(f'At {telemetry["alt"]}m. Generating {angle_deg}° grid...')
        await asyncio.sleep(1)

        waypoints = generate_grid_waypoints(polygon, altitude, spacing, angle_deg)
        total = len(waypoints)

        if not waypoints:
            await emit_status('No waypoints — try larger ROI or smaller spacing', error=True)
            return

        await emit_status(
            f'Grid ready: {total} waypoints at {angle_deg}°',
            waypoints=[{'lat': w[0], 'lon': w[1]} for w in waypoints],
            total_wp=total
        )
        await asyncio.sleep(1)

        for i, wp in enumerate(waypoints):
            if stop_mission:
                break
            goto(wp[0], wp[1], wp[2])
            pct = int(((i + 1) / total) * 100)
            await emit_status(
                f'Grid search: waypoint {i+1}/{total}',
                current_wp=i,
                total_wp=total,
                progress=pct,
                current_target={'lat': wp[0], 'lon': wp[1]}
            )
            await wait_for_condition(
                lambda: get_distance_m(telemetry['lat'], telemetry['lon'], wp[0], wp[1]) < 8.0,
                timeout=60
            )

        if stop_mission:
            await emit_status('Mission aborted by operator', aborted=True)
        else:
            await emit_status('Grid complete! Returning to launch...', progress=100)

        set_mode('RTL')
        await asyncio.sleep(1)
        await emit_status('RTL active. Mission complete!', complete=True)

    except Exception as e:
        await emit_status(f'Mission error: {str(e)}', error=True)
        import traceback; traceback.print_exc()

def abort_mission():
    global stop_mission
    stop_mission = True
    set_mode('RTL')
