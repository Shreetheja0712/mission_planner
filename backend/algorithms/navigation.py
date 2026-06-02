import math

def latlon_to_xy(lat, lon, origin_lat, origin_lon):
    x = (lon - origin_lon) * 111000.0 * math.cos(math.radians(origin_lat))
    y = (lat - origin_lat) * 111000.0
    return x, y

def xy_to_latlon(x, y, origin_lat, origin_lon):
    lat = origin_lat + y / 111000.0
    lon = origin_lon + x / (111000.0 * math.cos(math.radians(origin_lat)))
    return lat, lon

def rotate_point(x, y, angle_rad):
    rx = x * math.cos(angle_rad) - y * math.sin(angle_rad)
    ry = x * math.sin(angle_rad) + y * math.cos(angle_rad)
    return rx, ry

def point_in_polygon_xy(px, py, polygon_xy):
    n = len(polygon_xy)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon_xy[i]
        xj, yj = polygon_xy[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _build_sweep_path(rows, reverse_rows=False, start_from_right=False):
    ordered_rows = list(reversed(rows)) if reverse_rows else rows
    waypoints = []

    for index, row_points in enumerate(ordered_rows):
        if start_from_right == (index % 2 == 0):
            points = list(reversed(row_points))
        else:
            points = row_points

        waypoints.append(points[0])
        if len(points) > 1:
            waypoints.append(points[-1])

    return waypoints


def _orient_sweep_from_home(rows, home_xy):
    candidates = [
        _build_sweep_path(rows, reverse_rows=False, start_from_right=False),
        _build_sweep_path(rows, reverse_rows=False, start_from_right=True),
        _build_sweep_path(rows, reverse_rows=True, start_from_right=False),
        _build_sweep_path(rows, reverse_rows=True, start_from_right=True),
    ]

    def first_leg_distance(path):
        if not path:
            return math.inf
        return math.hypot(path[0][0] - home_xy[0], path[0][1] - home_xy[1])

    return min(candidates, key=first_leg_distance)


def generate_grid_waypoints(
    polygon,
    altitude,
    spacing_m=20,
    angle_deg=0,
    start_lat=None,
    start_lon=None,
):
    if len(polygon) < 3:
        return []

    origin_lat = sum(p[0] for p in polygon) / len(polygon)
    origin_lon = sum(p[1] for p in polygon) / len(polygon)

    poly_xy = [latlon_to_xy(p[0], p[1], origin_lat, origin_lon) for p in polygon]
    angle_rad = math.radians(angle_deg)
    poly_rot = [rotate_point(x, y, -angle_rad) for x, y in poly_xy]

    xs = [p[0] for p in poly_rot]
    ys = [p[1] for p in poly_rot]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    rows_rot = []
    current_y = min_y

    while current_y <= max_y + spacing_m:
        row_points = []
        step = spacing_m / 8.0
        current_x = min_x
        while current_x <= max_x + step:
            if point_in_polygon_xy(current_x, current_y, poly_rot):
                row_points.append((current_x, current_y))
            current_x += step

        if row_points:
            rows_rot.append(row_points)

        current_y += spacing_m

    if start_lat is not None and start_lon is not None:
        home_xy = latlon_to_xy(float(start_lat), float(start_lon), origin_lat, origin_lon)
        home_rot = rotate_point(home_xy[0], home_xy[1], -angle_rad)
        waypoints_rot = _orient_sweep_from_home(rows_rot, home_rot)
    else:
        waypoints_rot = _build_sweep_path(rows_rot)

    waypoints = []
    for (rx, ry) in waypoints_rot:
        x, y = rotate_point(rx, ry, angle_rad)
        lat, lon = xy_to_latlon(x, y, origin_lat, origin_lon)
        waypoints.append((lat, lon, altitude))

    return waypoints
