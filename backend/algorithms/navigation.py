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

def generate_grid_waypoints(polygon, altitude, spacing_m=20, angle_deg=0):
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

    waypoints_rot = []
    current_y = min_y
    row = 0

    while current_y <= max_y + spacing_m:
        row_points = []
        step = spacing_m / 8.0
        current_x = min_x
        while current_x <= max_x + step:
            if point_in_polygon_xy(current_x, current_y, poly_rot):
                row_points.append((current_x, current_y))
            current_x += step

        if row_points:
            if row % 2 == 1:
                row_points = row_points[::-1]
            waypoints_rot.append(row_points[0])
            if len(row_points) > 1:
                waypoints_rot.append(row_points[-1])

        current_y += spacing_m
        row += 1

    waypoints = []
    for (rx, ry) in waypoints_rot:
        x, y = rotate_point(rx, ry, angle_rad)
        lat, lon = xy_to_latlon(x, y, origin_lat, origin_lon)
        waypoints.append((lat, lon, altitude))

    return waypoints
