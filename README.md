this app programmed by mahmoud yousry (osvirus)

## Backend

The app now uses `backend/server.py` with SQLite instead of browser IndexedDB for attendance, movement samples, and admin logs.

Run from this folder:

```powershell
python backend/server.py
```

Serve the frontend separately, for example:

```powershell
python -m http.server 4173
```

The frontend calls `http://127.0.0.1:8000`. Set `FIELDMARK_ADMIN_PASSWORD` in production. Check-in is server-validated against the configured geofence; check-out is intentionally not location-restricted.

For deployment, set `apiBase` in `data.js` to the public API URL, then publish the frontend files on GitHub Pages. The backend includes `render.yaml` for Render and `backend/.env.example` for environment configuration. Set `FIELDMARK_ALLOWED_ORIGIN` to the exact GitHub Pages origin; do not use `*` in production.
