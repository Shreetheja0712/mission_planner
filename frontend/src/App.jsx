import { useEffect, useState } from 'react'

function App() {
  const [telemetry, setTelemetry] = useState(null)
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    // Connect to the FastAPI WebSocket
    const ws = new WebSocket('ws://localhost:5000/ws')
    
    ws.onopen = () => setIsConnected(true)
    ws.onclose = () => setIsConnected(false)

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'telemetry') {
        setTelemetry(message.data)
      }
    }
    
    return () => ws.close()
  }, [])

  return (
    <div style={{ padding: '20px' }}>
      <header style={{ marginBottom: '20px', borderBottom: '1px solid #1a2e44', paddingBottom: '10px' }}>
        <h1 style={{ fontFamily: 'var(--cond)', letterSpacing: '2px', color: 'var(--accent)' }}>
          SAR DRONE CONTROL
        </h1>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' }}>
          <div style={{
            width: '10px', height: '10px', borderRadius: '50%',
            backgroundColor: isConnected ? 'var(--green)' : 'var(--red)',
            boxShadow: `0 0 8px ${isConnected ? 'var(--green)' : 'var(--red)'}`
          }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text-dim)' }}>
            DATALINK: {isConnected ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </header>

      {telemetry ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          {/* Flight Data Card */}
          <div style={{ background: 'var(--panel)', padding: '20px', border: '1px solid var(--border)', borderRadius: '4px' }}>
            <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '10px', marginBottom: '15px' }}>
              FLIGHT DYNAMICS
            </h3>
            <p><strong>Altitude:</strong> {telemetry.alt.toFixed(1)} m</p>
            <p><strong>Heading:</strong> {telemetry.heading}°</p>
            <p><strong>Airspeed:</strong> {telemetry.airspeed} m/s</p>
            <p><strong>Groundspeed:</strong> {telemetry.groundspeed} m/s</p>
            <p><strong>Coordinates:</strong> {telemetry.lat.toFixed(6)}, {telemetry.lon.toFixed(6)}</p>
          </div>

          {/* System Status Card */}
          <div style={{ background: 'var(--panel)', padding: '20px', border: '1px solid var(--border)', borderRadius: '4px' }}>
            <h3 style={{ borderBottom: '1px solid var(--border)', paddingBottom: '10px', marginBottom: '15px' }}>
              SYSTEM STATUS
            </h3>
            <p><strong>Mode:</strong> <span style={{ color: 'var(--accent)' }}>{telemetry.mode}</span></p>
            <p><strong>Armed:</strong> <span style={{ color: telemetry.armed ? 'var(--green)' : 'var(--red)' }}>{telemetry.armed ? "ARMED" : "DISARMED"}</span></p>
            <p><strong>Battery:</strong> {telemetry.battery_voltage}V ({telemetry.battery_level}%)</p>
            <p><strong>GPS Fix:</strong> Type {telemetry.gps_fix} ({telemetry.satellites} Sats)</p>
          </div>
        </div>
      ) : (
        <p style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
          Waiting for telemetry data from backend...
        </p>
      )}
    </div>
  )
}

export default App
