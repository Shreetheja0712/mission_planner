# Mission Planner — SAR Drone Ground Control
 
A browser-based ground control station for autonomous **search-and-rescue (SAR) grid missions** on ArduPilot vehicles. Draw a region of interest (ROI) on a map, preview an auto-generated lawnmower search pattern, check the battery budget, and fly it, with live telemetry, automatic pause-and-RTL on low battery, and resume after recharge.
 
It is designed to run against ArduPilot **SITL** (software-in-the-loop) or a real vehicle that speaks MAVLink over UDP.
 
## Features
 
- **ROI drawing on a map**: click to add vertices, click the first point / press `Enter` / double-click to close, `Backspace` to undo, `Esc` to cancel. Satellite and dark map views.
- **Grid (lawnmower) path generation**: configurable altitude, line spacing, and sweep angle (slider plus presets). The sweep direction is oriented to start at the corner nearest the vehicle's position.
- **Battery prediction**: estimated distance, flight time, battery required, and projected battery after the route, checked against a 20 % reserve before you confirm a mission.
- **Autonomous mission execution**: GUIDED mode, arm, takeoff, then waypoint-by-waypoint flight with distance-scaled arrival timeouts, then RTL on completion.
- **Safety interrupts**: the mission pauses and triggers RTL when battery drops to 20 % or below. An operator or autopilot RTL / SMART_RTL is also detected and pauses the mission.
- **Checkpoint and resume**: the pause position is saved as a numbered RTL waypoint. After recharge, **Resume Mission** re-arms, takes off, rejoins the saved point, and continues from the next unvisited grid waypoint. Resume is blocked while battery is 20 % or lower or the link is down.
- **Crash-safe state**: active mission state is persisted to disk. If the backend restarts mid-mission, it comes back as *paused*.
- **Live telemetry**: position, altitude, heading, ground/air speed, battery, GPS fix, satellites, flight mode, and armed state streamed over WebSocket at about 4 Hz, with heartbeat-loss detection.
- **Manual controls**: manual takeoff to a chosen altitude, manual RTL, and mission abort (discards the mission and commands RTL).
- **Export**: download the previewed grid as a QGroundControl / Mission Planner compatible `.waypoints` file (`QGC WPL 110`).
## Architecture
 
```
┌────────────────────┐   WebSocket /ws (JSON)   ┌────────────────────────┐   MAVLink/UDP   ┌──────────────┐
│ Frontend           │ ◄──────────────────────► │ Backend (FastAPI)      │ ◄─────────────► │ ArduPilot    │
│ Vite + Leaflet     │  {command, payload}      │ mission logic, grid    │  pymavlink      │ SITL / drone │
│ http://localhost:3000│ {type, data}           │ planner, telemetry     │                 │              │
└────────────────────┘                          │ http://localhost:5000  │                 └──────────────┘
                                                └────────────────────────┘
```
 
```
backend/
  main.py                    FastAPI app, /ws endpoint, command dispatch
  core/config.py             Settings (MAVLink URL, mission state file)
  algorithms/navigation.py   Grid waypoint generation (polygon, rotation, sweep ordering)
  algorithms/mission.py      Mission state machine, battery model, pause/resume, persistence
  drone/mavlink_bridge.py    pymavlink connection, telemetry, mode/arm/takeoff/goto commands
  drone/telemetry_queue.py   Shared telemetry dict and connected WebSocket clients
  tests/                     unittest suites
frontend/
  src/main.js                Map, ROI drawing, mission UI, plan export
  src/socketBridge.js        WebSocket client wrapper
  src/map/                   Mission and vehicle map layers
  src/state/missionStore.js  Client-side mission state
  src/ui/telemetryPanel.js   Telemetry and connection panels
```
 
## Prerequisites
 
- Python 3.10+
- Node.js 18+ and npm
- An ArduPilot (ArduCopter) SITL instance or a vehicle sending MAVLink over UDP, for example [ArduPilot SITL](https://ardupilot.org/dev/docs/sitl-simulator-software-in-the-loop.html) with MAVProxy
## Getting Started
 
### 1. Start a simulated vehicle
 
Start ArduCopter SITL and make it send MAVLink to UDP port `14550` on the machine running the backend, for example:
 
```bash
sim_vehicle.py -v ArduCopter --console --out=udp:127.0.0.1:14550
```
 
The map defaults to the standard SITL home location (Canberra, AU).
 
### 2. Run the backend
 
```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 5000
```
 
The backend waits up to 30 seconds for a vehicle heartbeat at startup. If none arrives it keeps running and picks the vehicle up when a heartbeat appears. Health check: `GET http://localhost:5000/`.
 
### 3. Run the frontend
 
```bash
cd frontend
npm install
npm run dev
```
 
Open <http://localhost:3000>. When served on port 3000, 5173, or 4173, the frontend connects to the backend WebSocket at `<hostname>:5000/ws`. Otherwise it connects to the same host that served the page.
 
For a production build: `npm run build`, then `npm run preview`.
 
## Usage
 
1. Wait for the **drone link** indicator to show connected.
2. Click **Draw ROI Polygon** and outline the search area (3+ points), then **Finish Polygon**.
3. Adjust **altitude**, **spacing**, and **angle**. The grid preview and battery check update automatically.
4. Optionally click **Export Plan (WP)** to download a `.waypoints` file.
5. Click **Start Grid Search**, review the summary (waypoints, time, distance, projected battery, and any low-reserve warning), and click **Confirm Start**.
6. Monitor progress and the status log. Use **RTL / Pause Mission** to pause and return, **Resume Mission** after recharge, or **Abort Mission** to discard the mission.
## Configuration
 
| Variable | Default | Description |
| --- | --- | --- |
| `MAVLINK_URL` | `udp:127.0.0.1:14550` | pymavlink connection string for the vehicle |
| `MISSION_STATE_FILE` | `backend/runtime/mission_state.json` | Where the active mission checkpoint is stored |
 
Example for a different endpoint:
 
```bash
MAVLINK_URL=udpin:0.0.0.0:14551 uvicorn main:app --port 5000
```
 
Mission tuning constants (battery reserve, drain rate, cruise speed, timeouts) are defined at the top of `backend/algorithms/mission.py`.
 
## WebSocket Protocol
 
The frontend and backend exchange JSON messages on `/ws`.
 
**Client → server**: `{"command": "<name>", "payload": {...}}`
 
| Command | Payload | Effect |
| --- | --- | --- |
| `preview_grid` | `polygon`, `altitude`, `spacing`, `angle` | Returns a `grid_preview` with waypoints and battery prediction |
| `start_mission` | `polygon`, `altitude`, `spacing`, `angle` | Generates the grid and starts the mission |
| `resume_mission` | none | Resumes a paused mission |
| `abort_mission` | none | Discards the mission and commands RTL |
| `manual_takeoff` | `altitude` | GUIDED, arm, takeoff |
| `manual_rtl` | none | RTL (pauses the mission if one is running) |
 
`polygon` is a list of `[lat, lon]` pairs.
 
**Server → client**: `{"type": "<name>", "data": {...}}` with types `telemetry`, `connection_status`, `mission_status`, `mission_state`, and `grid_preview`.
 
## Tests
 
From the `backend` directory, with dependencies installed:
 
```bash
python -m unittest discover -s tests -v
```
 
The suites cover grid generation, the mission state machine (battery pause, RTL detection, resume, checkpoints, timeouts), and MAVLink heartbeat loss and recovery. The grid-generation tests need no third-party packages; the other suites import `pymavlink`, so install `requirements.txt` first.
 
## Safety Notes
 
- This software is intended for simulation and controlled testing. Always keep a manual override (RC transmitter) and follow local aviation regulations.
- The battery model is a simple linear estimate, not a substitute for real flight-time planning.
- The backend allows CORS from any origin and the WebSocket has no authentication. Do not expose it to untrusted networks.
 
