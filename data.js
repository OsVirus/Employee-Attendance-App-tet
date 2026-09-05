// data.js
window.APP_CONFIG = {
  apiBase: "http://127.0.0.1:8000",
  office: {
    lat: 29.9719381,
    lng: 31.1574611
  },
  geofenceRadiusMeters: 1000,
  maxGpsAccuracyMeters: 50,

  // الحركة (throttle)
  movementSampleEveryMs: 10000, // 10 ثواني تقريبًا
  outOfGeofenceFlagAfterMs: 30000, // إذا خارج النطاق 30 ثانية => flag

  // جلسة واحدة يوميًا
  allowMultipleSessionsPerDay: false,

  // كلمة مرور Admin محفوظة في Backend environment وليس في المتصفح
};