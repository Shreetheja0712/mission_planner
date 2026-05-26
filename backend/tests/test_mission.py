import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, call, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from algorithms import mission


class MissionStateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_state_file = mission.settings.MISSION_STATE_FILE
        mission.settings.MISSION_STATE_FILE = str(
            Path(self.temp_dir.name) / 'mission_state.json'
        )
        mission.mission_state = self.running_state()
        mission.rtl_detection_armed = False
        mission.telemetry.update({
            'lat': -35.1,
            'lon': 149.1,
            'alt': 20,
            'battery_level': 100,
            'mode': 'GUIDED',
            'armed': True,
        })
        self.set_mode = patch.object(mission, 'set_mode').start()
        self.goto = patch.object(mission, 'goto').start()
        self.takeoff = patch.object(mission, 'takeoff_cmd').start()
        self.arm = patch.object(mission, 'arm_vehicle').start()
        self.emit_ws = patch.object(mission, 'emit_ws', new=AsyncMock()).start()

    def tearDown(self):
        patch.stopall()
        mission.settings.MISSION_STATE_FILE = self.original_state_file
        self.temp_dir.cleanup()

    @staticmethod
    def running_state():
        return {
            'status': 'running',
            'id': 'mission-1',
            'polygon': [[-35.0, 149.0], [-35.0, 149.2], [-35.2, 149.1]],
            'altitude': 20,
            'spacing': 20,
            'angle': 0,
            'waypoints': [
                {'lat': -35.0, 'lon': 149.0, 'alt': 20},
                {'lat': -35.1, 'lon': 149.1, 'alt': 20},
            ],
            'next_wp': 1,
            'progress': 50,
            'rtl_waypoints': [],
            'pause_reason': None,
        }

    async def test_low_battery_pauses_and_saves_current_location(self):
        mission.telemetry['battery_level'] = 20

        outcome = await mission._monitor_interrupts('mission-1')

        self.assertEqual(outcome, 'paused')
        self.assertEqual(mission.mission_state['status'], 'paused')
        self.assertEqual(mission.mission_state['next_wp'], 1)
        self.assertEqual(mission.mission_state['rtl_waypoints'][0]['label'], 'RTL WP 1')
        self.assertEqual(mission.mission_state['rtl_waypoints'][0]['lat'], -35.1)
        self.set_mode.assert_called_once_with('RTL')
        self.assertTrue(Path(mission.settings.MISSION_STATE_FILE).exists())

    async def test_observed_rtl_modes_pause_once(self):
        for mode in ('RTL', 'SMART_RTL'):
            with self.subTest(mode=mode):
                mission.mission_state = self.running_state()
                mission.rtl_detection_armed = True
                mission.telemetry['mode'] = mode
                self.set_mode.reset_mock()

                self.assertEqual(
                    await mission._monitor_interrupts('mission-1'), 'paused'
                )
                self.assertEqual(len(mission.mission_state['rtl_waypoints']), 1)
                await mission._monitor_interrupts('mission-1')
                self.assertEqual(len(mission.mission_state['rtl_waypoints']), 1)
                self.set_mode.assert_not_called()

    async def test_resume_requires_battery_above_twenty_percent(self):
        mission.mission_state['status'] = 'paused'
        mission.telemetry['battery_level'] = 20

        self.assertFalse(await mission.resume_grid_mission())
        self.assertEqual(mission.mission_state['status'], 'paused')

        mission.telemetry['battery_level'] = 21
        tasks = []

        def capture_task(coro):
            tasks.append(coro)
            coro.close()

        with patch.object(mission.asyncio, 'create_task', side_effect=capture_task):
            self.assertTrue(await mission.resume_grid_mission())

        self.assertEqual(mission.mission_state['status'], 'running')
        self.assertEqual(len(tasks), 1)

    async def test_resume_rejoins_latest_rtl_point_before_pending_grid_point(self):
        mission.mission_state['rtl_waypoints'] = [
            {'number': 1, 'label': 'RTL WP 1', 'lat': -35.05, 'lon': 149.05, 'alt': 8}
        ]
        with (
            patch.object(mission, '_monitored_delay', new=AsyncMock(return_value=True)),
            patch.object(
                mission,
                'wait_for_condition',
                new=AsyncMock(side_effect=['reached', 'reached', 'reached', 'reached']),
            ),
            patch.object(mission.asyncio, 'sleep', new=AsyncMock()),
        ):
            await mission._run_mission('mission-1', resuming=True)

        self.assertEqual(
            self.goto.call_args_list,
            [
                call(-35.05, 149.05, 20),
                call(-35.1, 149.1, 20),
            ],
        )
        self.assertEqual(mission.mission_state['status'], 'completed')

    async def test_multiple_pauses_keep_numbered_rtl_history(self):
        await mission.pause_mission('First RTL')
        mission.mission_state['status'] = 'running'
        mission.telemetry['lat'] = -35.2
        mission.telemetry['lon'] = 149.2

        await mission.pause_mission('Second RTL')

        self.assertEqual(
            [wp['label'] for wp in mission.mission_state['rtl_waypoints']],
            ['RTL WP 1', 'RTL WP 2'],
        )

    async def test_abort_discards_checkpoint_without_adding_rtl_point(self):
        mission._persist_state()

        await mission.abort_mission()

        self.assertEqual(mission.mission_state['status'], 'aborted')
        self.assertEqual(mission.mission_state['rtl_waypoints'], [])
        self.assertFalse(Path(mission.settings.MISSION_STATE_FILE).exists())
        self.set_mode.assert_called_once_with('RTL')

    async def test_stale_scheduled_task_cannot_override_an_abort(self):
        mission.mission_state = mission._blank_state('aborted')

        await mission._run_mission('mission-1')

        self.set_mode.assert_not_called()
        self.arm.assert_not_called()
        self.takeoff.assert_not_called()

    async def test_normal_completion_rtl_does_not_create_pause_waypoint(self):
        mission.mission_state['next_wp'] = 0
        with (
            patch.object(mission, '_monitored_delay', new=AsyncMock(return_value=True)),
            patch.object(
                mission,
                'wait_for_condition',
                new=AsyncMock(side_effect=['reached', 'reached', 'reached', 'reached']),
            ),
            patch.object(mission.asyncio, 'sleep', new=AsyncMock()),
        ):
            await mission._run_mission('mission-1')

        self.assertEqual(mission.mission_state['status'], 'completed')
        self.assertEqual(mission.mission_state['rtl_waypoints'], [])
        self.assertEqual(self.set_mode.call_args_list[-1], call('RTL'))

    def test_loading_active_checkpoint_restores_it_as_paused(self):
        mission._persist_state()
        mission.mission_state = mission._blank_state()

        mission.load_mission_state()

        self.assertEqual(mission.mission_state['status'], 'paused')
        self.assertEqual(
            mission.mission_state['pause_reason'],
            'Backend restarted during active mission',
        )
        self.assertEqual(mission.mission_state['next_wp'], 1)


if __name__ == '__main__':
    unittest.main()
