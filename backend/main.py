import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json

from drone.mavlink_bridge import connect_vehicle, telemetry_loop, arm_vehicle, takeoff_cmd, set_mode
from drone.telemetry_queue import connected_clients
from algorithms.mission import execute_grid_mission, abort_mission, emit_ws
from algorithms.navigation import generate_grid_waypoints

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Connect to drone and start background telemetry task
    connected = await connect_vehicle()
    if connected:
        asyncio.create_task(telemetry_loop())
    else:
        print("[WARNING] Could not connect to SITL/Drone. Is it running?")
    yield
    # Shutdown logic can go here

app = FastAPI(lifespan=lifespan)

# Allow React frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    try:
        while True:
            # We can receive JSON commands here instead of SocketIO events!
            data_str = await websocket.receive_text()
            try:
                data = json.loads(data_str)
                command = data.get("command")
                payload = data.get("payload", {})

                if command == "manual_takeoff":
                    alt = float(payload.get("altitude", 10))
                    set_mode("GUIDED")
                    await asyncio.sleep(1)
                    arm_vehicle()
                    await asyncio.sleep(3)
                    takeoff_cmd(alt)
                elif command == "manual_rtl":
                    set_mode("RTL")
                elif command == "start_mission":
                    polygon = payload.get('polygon', [])
                    altitude = float(payload.get('altitude', 20))
                    spacing = float(payload.get('spacing', 20))
                    angle_deg = float(payload.get('angle', 0))
                    
                    if len(polygon) < 3:
                        await emit_ws('mission_status', {'status': 'Need at least 3 ROI points', 'error': True})
                    else:
                        # Launch mission loop as a background task
                        asyncio.create_task(execute_grid_mission(polygon, altitude, spacing, angle_deg))
                elif command == "preview_grid":
                    polygon = payload.get('polygon', [])
                    altitude = float(payload.get('altitude', 20))
                    spacing = float(payload.get('spacing', 20))
                    angle_deg = float(payload.get('angle', 0))
                    if len(polygon) >= 3:
                        waypoints = generate_grid_waypoints(polygon, altitude, spacing, angle_deg)
                        await emit_ws('grid_preview', {
                            'waypoints': [{'lat': w[0], 'lon': w[1]} for w in waypoints],
                            'total_wp': len(waypoints),
                            'angle': angle_deg
                        })
                elif command == "abort_mission":
                    abort_mission()
                    await emit_ws('mission_status', {'status': 'ABORT — RTL activated', 'aborted': True})
                
            except Exception as e:
                print(f"Error handling WebSocket message: {e}")

    except WebSocketDisconnect:
        connected_clients.remove(websocket)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "FastAPI Ground Control running!"}
