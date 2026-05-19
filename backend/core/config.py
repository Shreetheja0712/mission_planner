import os

class Settings:
    MAVLINK_URL = os.getenv("MAVLINK_URL", "udp:127.0.0.1:14550")
    PORT = 5000

settings = Settings()
