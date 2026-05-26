import asyncio
import json
import math
from pathlib import Path
from uuid import uuid4

from core.config import settings
from drone.mavlink_bridge import arm_vehicle, goto, set_mode, takeoff_cmd
from drone.telemetry_queue import connected_clients, telemetry
from algorithms.navigation import generate_grid_waypoints


RTL_MODES = {'RTL', 'SMART_RTL'}
RUNNING_STATES = {'running', 'paused'}
mission_state = {'status': 'idle'}
rtl_detection_armed = False


async def emit_ws(msg_type, data):
    payload = json.dumps({'type': msg_type, 'data': data})
    for client in list(connected_clients):
        try:
            await client.send_text(payload)
        except Exception:
            pass


async def emit_status(msg, **kwargs):
    data = {'status': msg}
    data.update(kwargs)
    await emit_ws('mission_status', data)
    print(f'[MISSION] {msg}')


def _state_file():
    return Path(settings.MISSION_STATE_FILE)


def _blank_state(status='idle'):
    return {
        'status': status,
        'id': None,
        'polygon': [],
        'altitude': 0,
        'spacing': 0,
        'angle': 0,
        'waypoints': [],
        'next_wp': 0,
        'progress': 0,
        'rtl_waypoints': [],
        'pause_reason': None,
    }


def _persist_state():
    path = _state_file()
    if mission_state.get('status') not in RUNNING_STATES:
        path.unlink(missing_ok=True)
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f'{path.suffix}.tmp')
    temporary.write_text(json.dumps(mission_state, indent=2), encoding='utf-8')
    temporary.replace(path)


def load_mission_state():
    global mission_state
    path = _state_file()
    mission_state = _blank_state()
    if not path.exists():
        return

    try:
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved.get('status') not in RUNNING_STATES:
            path.unlink(missing_ok=True)
            return
        mission_state = _blank_state('paused')
        mission_state.update(saved)
        if saved.get('status') == 'running':
            mission_state['status'] = 'paused'
            mission_state['pause_reason'] = 'Backend restarted during active mission'
            _persist_state()
    except (OSError, ValueError, TypeError):
        mission_state = _blank_state()
        path.unlink(missing_ok=True)


def get_mission_snapshot():
    battery = telemetry.get('battery_level', -1)
    snapshot = dict(mission_state)
    snapshot['waypoints'] = [dict(wp) for wp in mission_state.get('waypoints', [])]
    snapshot['rtl_waypoints'] = [dict(wp) for wp in mission_state.get('rtl_waypoints', [])]
    snapshot['locked'] = mission_state.get('status') in RUNNING_STATES
    snapshot['resume_allowed'] = (
        mission_state.get('status') == 'paused' and battery > 20
    )
    return snapshot


async def emit_mission_state():
    await emit_ws('mission_state', get_mission_snapshot())


async def send_mission_state(client):
    await client.send_text(json.dumps({
        'type': 'mission_state',
        'data': get_mission_snapshot(),
    }))


def mission_is_running():
    return mission_state.get('status') == 'running'


def mission_is_paused():
    return mission_state.get('status') == 'paused'


def get_distance_m(lat1, lon1, lat2, lon2):
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    return math.sqrt(dlat**2 + dlon**2) * 1.113195e5


def _same_running_mission(mission_id):
    return (
        mission_state.get('id') == mission_id
        and mission_state.get('status') == 'running'
    )


def _current_rtl_waypoint():
    lat = telemetry.get('lat', 0)
    lon = telemetry.get('lon', 0)
    if not lat and not lon:
        return None

    number = len(mission_state.get('rtl_waypoints', [])) + 1
    return {
        'number': number,
        'label': f'RTL WP {number}',
        'lat': lat,
        'lon': lon,
        'alt': telemetry.get('alt', 0),
    }


async def pause_mission(reason, command_rtl=True):
    if not mission_is_running():
        return False

    waypoint = _current_rtl_waypoint()
    if waypoint:
        mission_state['rtl_waypoints'].append(waypoint)
    mission_state['status'] = 'paused'
    mission_state['pause_reason'] = reason
    _persist_state()

    if command_rtl:
        set_mode('RTL')

    label = waypoint['label'] if waypoint else 'current position unavailable'
    await emit_status(
        f'Mission paused: {reason}. Saved {label}.',
        paused=True,
        progress=mission_state.get('progress', 0),
        rtl_waypoint=waypoint,
    )
    await emit_mission_state()
    return True


async def abort_mission():
    global mission_state
    was_active = mission_state.get('status') in RUNNING_STATES
    mission_state = _blank_state('aborted')
    _persist_state()
    set_mode('RTL')
    await emit_status(
        'Mission aborted by operator. RTL activated.',
        aborted=True,
        progress=0,
    )
    await emit_mission_state()
    return was_active


async def _monitor_interrupts(mission_id):
    global rtl_detection_armed
    if not _same_running_mission(mission_id):
        return mission_state.get('status', 'aborted')

    battery = telemetry.get('battery_level', -1)
    if 0 <= battery <= 20:
        await pause_mission(f'Battery critical ({battery}%)', command_rtl=True)
        return 'paused'

    mode = telemetry.get('mode', '--')
    if mode in RTL_MODES and rtl_detection_armed:
        await pause_mission(f'{mode} activated', command_rtl=False)
        return 'paused'
    if mode not in RTL_MODES and mode != '--':
        rtl_detection_armed = True
    return 'running'


async def wait_for_condition(mission_id, condition_fn, timeout=30, interval=0.3):
    elapsed = 0
    while elapsed < timeout:
        interrupted = await _monitor_interrupts(mission_id)
        if interrupted != 'running':
            return interrupted
        if condition_fn():
            return 'reached'
        await asyncio.sleep(interval)
        elapsed += interval
    return 'timeout'


async def _monitored_delay(mission_id, delay):
    result = await wait_for_condition(mission_id, lambda: False, timeout=delay, interval=0.2)
    return result == 'timeout'


async def _fail_mission(mission_id, msg):
    global mission_state
    if mission_state.get('id') != mission_id:
        return
    mission_state = _blank_state('aborted')
    _persist_state()
    await emit_status(msg, error=True)
    await emit_mission_state()


async def _run_mission(mission_id, resuming=False):
    global rtl_detection_armed, mission_state
    rtl_detection_armed = False

    try:
        if not _same_running_mission(mission_id):
            return
        await emit_status('Setting GUIDED mode...')
        if not _same_running_mission(mission_id):
            return
        set_mode('GUIDED')
        if not await _monitored_delay(mission_id, 2):
            return

        await emit_status('Arming motors...')
        if not _same_running_mission(mission_id):
            return
        arm_vehicle()
        armed = await wait_for_condition(mission_id, lambda: telemetry['armed'], timeout=15)
        if armed != 'reached':
            if armed == 'timeout':
                await _fail_mission(mission_id, 'Failed to arm! In SITL console type: arm throttle')
            return

        altitude = mission_state['altitude']
        await emit_status('Armed! Taking off...')
        if not _same_running_mission(mission_id):
            return
        if not await _monitored_delay(mission_id, 1):
            return
        if not _same_running_mission(mission_id):
            return
        takeoff_cmd(altitude)

        reached = await wait_for_condition(
            mission_id,
            lambda: telemetry['alt'] >= altitude * 0.90,
            timeout=40,
        )
        if reached != 'reached':
            if reached == 'timeout':
                await _fail_mission(mission_id, f'Takeoff timeout at {telemetry["alt"]}m')
            return

        if resuming and mission_state.get('rtl_waypoints'):
            rtl_wp = mission_state['rtl_waypoints'][-1]
            await emit_status(f'Rejoining search through {rtl_wp["label"]}...')
            if not _same_running_mission(mission_id):
                return
            goto(rtl_wp['lat'], rtl_wp['lon'], altitude)
            rejoined = await wait_for_condition(
                mission_id,
                lambda: get_distance_m(
                    telemetry['lat'], telemetry['lon'], rtl_wp['lat'], rtl_wp['lon']
                ) < 8.0,
                timeout=60,
            )
            if rejoined != 'reached':
                if rejoined == 'timeout':
                    await pause_mission(f'Could not reach {rtl_wp["label"]}', command_rtl=True)
                return
            await emit_status(f'Reached {rtl_wp["label"]}. Continuing grid search.')

        waypoints = mission_state['waypoints']
        total = len(waypoints)
        for index in range(mission_state['next_wp'], total):
            if not _same_running_mission(mission_id):
                return
            wp = waypoints[index]
            goto(wp['lat'], wp['lon'], wp['alt'])
            await emit_status(
                f'Grid search: waypoint {index + 1}/{total}',
                current_wp=index,
                total_wp=total,
                progress=mission_state['progress'],
                current_target={'lat': wp['lat'], 'lon': wp['lon']},
            )
            arrival = await wait_for_condition(
                mission_id,
                lambda: get_distance_m(
                    telemetry['lat'], telemetry['lon'], wp['lat'], wp['lon']
                ) < 8.0,
                timeout=60,
            )
            if arrival != 'reached':
                if arrival == 'timeout':
                    await pause_mission(
                        f'Timeout approaching waypoint {index + 1}', command_rtl=True
                    )
                return

            mission_state['next_wp'] = index + 1
            mission_state['progress'] = int(((index + 1) / total) * 100)
            _persist_state()
            await emit_status(
                f'Reached waypoint {index + 1}/{total}',
                current_wp=index,
                total_wp=total,
                progress=mission_state['progress'],
            )
            await emit_mission_state()

        if not _same_running_mission(mission_id):
            return
        mission_state['status'] = 'completed'
        mission_state['progress'] = 100
        mission_state['pause_reason'] = None
        _persist_state()
        await emit_status('Grid complete! Returning to launch...', progress=100)
        await emit_mission_state()
        set_mode('RTL')
        await asyncio.sleep(1)
        await emit_status('RTL active. Mission complete!', complete=True, progress=100)
    except Exception as exc:
        await _fail_mission(mission_id, f'Mission error: {exc}')
        import traceback
        traceback.print_exc()


async def start_grid_mission(polygon, altitude, spacing, angle_deg):
    global mission_state
    if mission_state.get('status') in RUNNING_STATES:
        await emit_status('Resume or abort the active mission before starting a new search.', error=True)
        await emit_mission_state()
        return False

    waypoints = generate_grid_waypoints(polygon, altitude, spacing, angle_deg)
    if not waypoints:
        await emit_status('No waypoints - try larger ROI or smaller spacing', error=True)
        return False

    mission_state = {
        'status': 'running',
        'id': str(uuid4()),
        'polygon': polygon,
        'altitude': altitude,
        'spacing': spacing,
        'angle': angle_deg,
        'waypoints': [
            {'lat': wp[0], 'lon': wp[1], 'alt': wp[2]} for wp in waypoints
        ],
        'next_wp': 0,
        'progress': 0,
        'rtl_waypoints': [],
        'pause_reason': None,
    }
    _persist_state()
    await emit_status(
        f'Grid ready: {len(waypoints)} waypoints at {angle_deg} degrees',
        waypoints=mission_state['waypoints'],
        total_wp=len(waypoints),
        progress=0,
    )
    await emit_mission_state()
    asyncio.create_task(_run_mission(mission_state['id']))
    return True


async def resume_grid_mission():
    if not mission_is_paused():
        await emit_status('No paused mission is available to resume.', error=True)
        await emit_mission_state()
        return False

    battery = telemetry.get('battery_level', -1)
    if battery <= 20:
        await emit_status('Recharge required: battery must be above 20% to resume.', error=True)
        await emit_mission_state()
        return False

    mission_state['status'] = 'running'
    mission_state['pause_reason'] = None
    _persist_state()
    await emit_status(
        f'Resuming mission from waypoint {mission_state["next_wp"] + 1}.',
        progress=mission_state['progress'],
    )
    await emit_mission_state()
    asyncio.create_task(_run_mission(mission_state['id'], resuming=True))
    return True
