import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from drone import mavlink_bridge


class MavlinkReconnectTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        mavlink_bridge.vehicle = Mock()
        mavlink_bridge.vehicle_connected = False
        mavlink_bridge.last_heartbeat = None
        mavlink_bridge.telemetry.update({'mode': '--', 'armed': False})
        self.request_stream = patch.object(
            mavlink_bridge, 'request_data_stream'
        ).start()
        self.emit_connection = patch.object(
            mavlink_bridge, 'emit_connection_status', new=AsyncMock()
        ).start()

    def tearDown(self):
        patch.stopall()

    @staticmethod
    def heartbeat(mode=4):
        message = Mock()
        message.get_type.return_value = 'HEARTBEAT'
        message.get_srcComponent.return_value = 1
        message.custom_mode = mode
        message.base_mode = 0
        return message

    async def test_heartbeat_loss_then_reconnect_restores_live_link(self):
        with patch.object(mavlink_bridge.time, 'monotonic', return_value=100.0):
            await mavlink_bridge.handle_message(self.heartbeat())

        self.assertTrue(mavlink_bridge.is_vehicle_connected())
        self.assertEqual(mavlink_bridge.telemetry['mode'], 'GUIDED')
        self.request_stream.assert_called_once_with()
        self.emit_connection.assert_awaited_with(True)

        with patch.object(
            mavlink_bridge.time,
            'monotonic',
            return_value=100.0 + mavlink_bridge.HEARTBEAT_TIMEOUT_SECONDS + 1,
        ):
            self.assertTrue(await mavlink_bridge.check_heartbeat_timeout())

        self.assertFalse(mavlink_bridge.is_vehicle_connected())
        self.assertEqual(mavlink_bridge.telemetry['mode'], '--')
        self.emit_connection.assert_awaited_with(False, 'Vehicle heartbeat lost')

        with patch.object(mavlink_bridge.time, 'monotonic', return_value=110.0):
            await mavlink_bridge.handle_message(self.heartbeat(mode=6))

        self.assertTrue(mavlink_bridge.is_vehicle_connected())
        self.assertEqual(mavlink_bridge.telemetry['mode'], 'RTL')
        self.assertEqual(self.request_stream.call_count, 2)


if __name__ == '__main__':
    unittest.main()
