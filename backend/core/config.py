import os
from pathlib import Path

class Settings:
    MAVLINK_URL = os.getenv("MAVLINK_URL", "udp:127.0.0.1:14550")
    PORT = 5000
    MISSION_STATE_FILE = os.getenv(
        "MISSION_STATE_FILE",
        str(Path(__file__).resolve().parent.parent / "runtime" / "mission_state.json"),
    )

settings = Settings()
