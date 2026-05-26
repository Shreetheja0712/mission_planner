import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json

from drone.mavlink_bridge import (
    arm_vehicle,
    connect_vehicle,
    is_vehicle_connected,
    set_mode,
    takeoff_cmd,
    telemetry_loop,
)
from drone.telemetry_queue import connected_clients
from algorithms.mission import (
    abort_mission,
    emit_ws,
    load_mission_state,
    mission_is_running,
    pause_mission,
    resume_grid_mission,
    send_mission_state,
    start_grid_mission,
)
from algorithms.navigation import generate_grid_waypoints

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Connect to drone and start background telemetry task
    load_mission_state()
    connected = await connect_vehicle()
    asyncio.create_task(telemetry_loop())
    if connected:
        print("[SAR] Vehicle link online")
    else:
        print("[WARNING] Waiting for SITL/Drone heartbeat on the configured UDP endpoint.")
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
    print('[SAR] Browser connected')
    await websocket.send_text(json.dumps({
        "type": "connection_status",
        "data": {"connected": is_vehicle_connected()}
    }))
    await send_mission_state(websocket)
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
                    await emit_ws('mission_status', {'status': f'Manual takeoff \u2192 {alt}m'})
                elif command == "manual_rtl":
                    if mission_is_running():
                        await pause_mission('Operator RTL activated', command_rtl=True)
                    else:
                        set_mode("RTL")
                        await emit_ws('mission_status', {'status': 'RTL activated'})
                elif command == "start_mission":
                    polygon = payload.get('polygon', [])
                    altitude = float(payload.get('altitude', 20))
                    spacing = float(payload.get('spacing', 20))
                    angle_deg = float(payload.get('angle', 0))
                    
                    if len(polygon) < 3:
                        await emit_ws('mission_status', {'status': 'Need at least 3 ROI points', 'error': True})
                    else:
                        await start_grid_mission(polygon, altitude, spacing, angle_deg)
                elif command == "resume_mission":
                    await resume_grid_mission()
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
                    await abort_mission()
                
            except Exception as e:
                print(f"Error handling WebSocket message: {e}")

    except WebSocketDisconnect:
        connected_clients.discard(websocket)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "FastAPI Ground Control running!"}
