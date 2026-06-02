import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from algorithms.navigation import generate_grid_waypoints


class NavigationTests(unittest.TestCase):
    def test_grid_defaults_to_existing_scan_order_without_home(self):
        polygon = [
            [0.0, 0.0],
            [0.0, 0.003],
            [0.003, 0.003],
            [0.003, 0.0],
        ]

        waypoints = generate_grid_waypoints(polygon, altitude=20, spacing_m=100)

        self.assertLess(waypoints[0][0], waypoints[-1][0])
        self.assertLess(waypoints[0][1], waypoints[1][1])

    def test_grid_starts_at_closest_sweep_corner_to_home(self):
        polygon = [
            [0.0, 0.0],
            [0.0, 0.003],
            [0.003, 0.003],
            [0.003, 0.0],
        ]

        waypoints = generate_grid_waypoints(
            polygon,
            altitude=20,
            spacing_m=100,
            start_lat=0.0035,
            start_lon=0.0035,
        )

        self.assertGreater(waypoints[0][0], waypoints[-1][0])
        self.assertGreater(waypoints[0][1], 0.0015)


if __name__ == '__main__':
    unittest.main()
