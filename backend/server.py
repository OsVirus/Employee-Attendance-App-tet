import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "attendance.db")
HOST = os.environ.get("FIELDMARK_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", os.environ.get("FIELDMARK_PORT", "8000")))
ALLOWED_ORIGIN = os.environ.get("FIELDMARK_ALLOWED_ORIGIN", "http://localhost:4174")
ADMIN_PASSWORD = os.environ.get("FIELDMARK_ADMIN_PASSWORD", "ERA@NOKIA123")
OFFICE_LAT = float(os.environ.get("FIELDMARK_OFFICE_LAT", "29.9719381"))
OFFICE_LNG = float(os.environ.get("FIELDMARK_OFFICE_LNG", "31.1574611"))
GEOFENCE_METERS = float(os.environ.get("FIELDMARK_GEOFENCE_METERS", "1000"))
MAX_ACCURACY = float(os.environ.get("FIELDMARK_MAX_ACCURACY", "50"))
SESSIONS = {}


def now_ms():
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS attendance (
          id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, username TEXT NOT NULL,
          date TEXT NOT NULL, check_in_time INTEGER NOT NULL, check_in_lat REAL NOT NULL,
          check_in_lng REAL NOT NULL, check_in_accuracy REAL NOT NULL, check_out_time INTEGER,
          check_out_lat REAL, check_out_lng REAL, work_seconds INTEGER, flags TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS movement_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT, attendance_id TEXT NOT NULL, captured_at INTEGER NOT NULL,
          lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL NOT NULL, meters_from_office REAL NOT NULL,
          in_fence INTEGER NOT NULL, FOREIGN KEY(attendance_id) REFERENCES attendance(id)
        );
        """)


def distance_meters(lat1, lng1, lat2, lng2):
    radius = 6371000
    radians = math.pi / 180
    dlat = (lat2 - lat1) * radians
    dlng = (lng2 - lng1) * radians
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1 * radians) * math.cos(lat2 * radians) * math.sin(dlng / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def employee_id(username):
    return "emp-" + hashlib.sha256(username.casefold().encode()).hexdigest()[:16]


def body(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    return json.loads(handler.rfile.read(length) or "{}")


def auth(handler, role=None):
    token = handler.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    current = SESSIONS.get(token)
    if not current or (role and current["role"] != role):
        return None
    return current


def serialize(row):
    if not row:
        return None
    item = dict(row)
    item["flags"] = json.loads(item["flags"] or "[]")
    return item


class API(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(fmt % args)

    def reply(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.reply({}, 204)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.reply({"ok": True, "service": "employee-attendance-api"})
            return
        if path in ("/api/attendance/me", "/api/attendance/my"):
            user = auth(self, "employee")
            if not user:
                self.reply({"error": "تسجيل دخول الموظف مطلوب"}, 401)
                return
            with db() as conn:
                rows = conn.execute("SELECT * FROM attendance WHERE employee_id = ? ORDER BY date DESC, check_in_time DESC", (user["employee_id"],)).fetchall()
            self.reply({"logs": [serialize(row) for row in rows]})
            return
        if path == "/api/admin/logs":
            if not auth(self, "admin"):
                self.reply({"error": "تسجيل دخول المدير مطلوب"}, 401)
                return
            with db() as conn:
                rows = conn.execute("SELECT * FROM attendance ORDER BY check_in_time DESC").fetchall()
            self.reply({"logs": [serialize(row) for row in rows]})
            return
        self.reply({"error": "المسار غير موجود"}, 404)

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            data = body(self)
            if path == "/api/auth/login": self.login(data)
            elif path == "/api/attendance/check-in": self.check_in(data)
            elif path == "/api/attendance/check-out": self.check_out()
            elif path == "/api/attendance/movement": self.movement(data)
            else: self.reply({"error": "المسار غير موجود"}, 404)
        except (KeyError, ValueError, json.JSONDecodeError) as error:
            self.reply({"error": str(error) or "بيانات غير صحيحة"}, 400)
        except Exception as error:
            print(error)
            self.reply({"error": "خطأ داخلي في الخادم"}, 500)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/api/attendance/my":
            user = auth(self, "employee")
            if not user: self.reply({"error": "تسجيل دخول الموظف مطلوب"}, 401); return
            with db() as conn:
                conn.execute("DELETE FROM attendance WHERE employee_id = ?", (user["employee_id"],))
            self.reply({"ok": True}); return
        if path == "/api/admin/logs":
            if not auth(self, "admin"): self.reply({"error": "تسجيل دخول المدير مطلوب"}, 401); return
            with db() as conn: conn.execute("DELETE FROM attendance")
            self.reply({"ok": True}); return
        self.reply({"error": "المسار غير موجود"}, 404)

    def login(self, data):
        role = data.get("role")
        username = str(data.get("username", "")).strip()
        if role == "admin":
            if not hmac.compare_digest(str(data.get("password", "")), ADMIN_PASSWORD):
                self.reply({"error": "كلمة مرور Admin غير صحيحة"}, 401); return
            user = {"role": "admin", "username": username or "Admin"}
        elif role == "employee" and username and len(username) <= 120:
            user = {"role": "employee", "username": username, "employee_id": employee_id(username)}
        else:
            self.reply({"error": "اكتب اسم الموظف"}, 400); return
        token = secrets.token_urlsafe(32)
        SESSIONS[token] = user
        self.reply({"token": token, "user": user})

    def check_in(self, data):
        user = auth(self, "employee")
        if not user: self.reply({"error": "تسجيل دخول الموظف مطلوب"}, 401); return
        lat, lng, accuracy = float(data["lat"]), float(data["lng"]), float(data["accuracy"])
        if accuracy > MAX_ACCURACY: self.reply({"error": f"دقة GPS أعلى من {MAX_ACCURACY}m"}, 422); return
        distance = distance_meters(OFFICE_LAT, OFFICE_LNG, lat, lng)
        if distance > GEOFENCE_METERS: self.reply({"error": "خارج نطاق المكتب"}, 422); return
        timestamp = now_ms(); date = datetime.now().strftime("%Y-%m-%d")
        with db() as conn:
            existing = conn.execute("SELECT id FROM attendance WHERE employee_id = ? AND date = ?", (user["employee_id"], date)).fetchone()
            if existing: self.reply({"error": "تم تسجيل حضور اليوم بالفعل"}, 409); return
            record_id = f"{user['employee_id']}_{date}"
            conn.execute("INSERT INTO attendance (id, employee_id, username, date, check_in_time, check_in_lat, check_in_lng, check_in_accuracy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (record_id, user["employee_id"], user["username"], date, timestamp, lat, lng, accuracy))
            conn.execute("INSERT INTO movement_samples (attendance_id, captured_at, lat, lng, accuracy, meters_from_office, in_fence) VALUES (?, ?, ?, ?, ?, ?, 1)", (record_id, timestamp, lat, lng, accuracy, distance))
        self.reply({"ok": True, "record_id": record_id})

    def movement(self, data):
        user = auth(self, "employee")
        if not user: self.reply({"error": "تسجيل دخول الموظف مطلوب"}, 401); return
        lat, lng, accuracy = float(data["lat"]), float(data["lng"]), float(data["accuracy"]); timestamp = now_ms()
        distance = distance_meters(OFFICE_LAT, OFFICE_LNG, lat, lng); in_fence = distance <= GEOFENCE_METERS
        with db() as conn:
            row = conn.execute("SELECT * FROM attendance WHERE employee_id = ? AND check_out_time IS NULL ORDER BY check_in_time DESC LIMIT 1", (user["employee_id"],)).fetchone()
            if not row: self.reply({"error": "لا يوجد شيفت مفتوح"}, 409); return
            flags = json.loads(row["flags"] or "[]")
            if not in_fence and "OUT_OF_GEOFENCE" not in flags: flags.append("OUT_OF_GEOFENCE")
            conn.execute("UPDATE attendance SET flags = ? WHERE id = ?", (json.dumps(flags), row["id"]))
            conn.execute("INSERT INTO movement_samples (attendance_id, captured_at, lat, lng, accuracy, meters_from_office, in_fence) VALUES (?, ?, ?, ?, ?, ?, ?)", (row["id"], timestamp, lat, lng, accuracy, distance, int(in_fence)))
        self.reply({"ok": True, "in_fence": in_fence, "distance": distance})

    def check_out(self):
        user = auth(self, "employee")
        if not user: self.reply({"error": "تسجيل دخول الموظف مطلوب"}, 401); return
        timestamp = now_ms()
        with db() as conn:
            row = conn.execute("SELECT * FROM attendance WHERE employee_id = ? AND check_out_time IS NULL ORDER BY check_in_time DESC LIMIT 1", (user["employee_id"],)).fetchone()
            if not row: self.reply({"error": "لا يوجد Check-in مفتوح"}, 409); return
            seconds = max(0, (timestamp - row["check_in_time"]) // 1000)
            conn.execute("UPDATE attendance SET check_out_time = ?, check_out_lat = check_in_lat, check_out_lng = check_in_lng, work_seconds = ? WHERE id = ?", (timestamp, seconds, row["id"]))
        self.reply({"ok": True, "work_seconds": seconds})


if __name__ == "__main__":
    init_db()
    print(f"Employee Attendance API running at http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), API).serve_forever()
