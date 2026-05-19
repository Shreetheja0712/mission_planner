import asyncio

# Shared state between MAVLink process and Web process
telemetry = {
    'lat': 0, 'lon': 0, 'alt': 0,
    'heading': 0, 'groundspeed': 0, 'airspeed': 0,
    'battery_voltage': 0, 'battery_level': 0,
    'mode': '--', 'armed': False,
    'gps_fix': 0, 'satellites': 0,
}

# We can store our connected websockets to manually broadcast (or use a pub/sub pattern)
connected_clients = set()
