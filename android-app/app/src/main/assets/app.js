// app.js
const {
  office,
  geofenceRadiusMeters,
  maxGpsAccuracyMeters,
  movementSampleEveryMs,
  outOfGeofenceFlagAfterMs,
  allowMultipleSessionsPerDay,
  adminPassword
} = window.APP_CONFIG;

const $ = (id) => document.getElementById(id);

const state = {
  user: null, // { username, role }
  watchId: null,
  lastSampleAt: 0,
  outOfRangeSince: null,
  adminLogs: []
};

const DB_NAME = "attendance_db_v1";
const DB_VERSION = 1;
const STORE_LOGS = "attendanceLogs";
const STORE_MOVEMENT = "movementSamples";
const STORE_USERS = "users";

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 3200);
}

function formatDateYMD(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        const s = db.createObjectStore(STORE_LOGS, { keyPath: "id" });
        s.createIndex("byUsernameDate", ["username", "date"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_MOVEMENT)) {
        db.createObjectStore(STORE_MOVEMENT, { keyPath: "id" });
        // no strict indexes needed for this demo
      }
      if (!db.objectStoreNames.contains(STORE_USERS)) {
        db.createObjectStore(STORE_USERS, { keyPath: "username" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objectStore = tx.objectStore(store);
    const req = objectStore.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const req = s.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const req = s.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClear(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const req = s.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGetLogsForUsername(username) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOGS, "readonly");
    const s = tx.objectStore(STORE_LOGS);
    const idx = s.index("byUsernameDate");
    const range = IDBKeyRange.bound([username, "0000-00-00"], [username, "9999-12-31"]);
    const req = idx.openCursor(range);
    const out = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else { resolve(out); }
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAllLogs() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOGS, "readonly");
    const s = tx.objectStore(STORE_LOGS);
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function ensureUser(username) {
  username = (username || "").trim();
  if (!username) throw new Error("Username مطلوب.");
  const existing = await dbGet(STORE_USERS, username);
  if (!existing) {
    await dbPut(STORE_USERS, { username, createdAt: Date.now() });
  }
}

function requestPositionOnce(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation غير مدعوم."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

function computeGeoOk(coords) {
  const { latitude, longitude, accuracy } = coords;
  const metersFromOffice = haversineMeters(office.lat, office.lng, latitude, longitude);
  const accOk = accuracy <= maxGpsAccuracyMeters;
  const inFence = metersFromOffice <= geofenceRadiusMeters;
  return { inFence, accOk, metersFromOffice, accuracy, lat: latitude, lng: longitude };
}

async function attemptCheckIn() {
  const username = state.user.username;
  const date = formatDateYMD();

  const existing = await getTodayLog(username);
  if (existing && existing.checkIn && !existing.checkOut) {
    throw new Error("موجود Check-in اليوم بالفعل. انتظر Check-out.");
  }
  if (existing && existing.checkIn && existing.checkOut) {
    throw new Error("تم إغلاق جلسة اليوم بالفعل.");
  }
  if (existing && existing.checkIn && existing.checkOut && !allowMultipleSessionsPerDay) {
    throw new Error("جلسة واحدة فقط في اليوم.");
  }

  $("geoStatus").textContent = "جاري الحصول على الموقع (Check-in)...";

  const pos = await requestPositionOnce();
  const geo = computeGeoOk(pos.coords);

  if (!geo.accOk) throw new Error(`رفض: دقة GPS (${Math.round(geo.accuracy)}m) أعلى من الحد (${maxGpsAccuracyMeters}m).`);
  if (!geo.inFence) throw new Error(`رفض: خارج نطاق المكتب (المسافة ~ ${Math.round(geo.metersFromOffice)}m، المسموح ${geofenceRadiusMeters}m).`);

  const now = Date.now();
  const log = {
    id: `${username}_${date}_in_${now}`,
    username,
    date,
    checkIn: {
      time: now,
      lat: geo.lat,
      lng: geo.lng,
      accuracy: geo.accuracy
    },
    checkOut: null,
    workSeconds: null,
    flags: []
  };

  await dbPut(STORE_LOGS, log);

  // start movement watch
  startMovementWatch(username, date);

  $("geoStatus").textContent = `Check-in تم ✅ | accuracy=${Math.round(geo.accuracy)}m`;
  toast("تم Check-in بنجاح.");
  return log;
}

async function attemptCheckOut() {
  const username = state.user.username;
  const date = formatDateYMD();

  const log = await getTodayLog(username);
  if (!log || !log.checkIn) throw new Error("لا يوجد Check-in اليوم.");
  if (log.checkOut) throw new Error("تم Check-out بالفعل.");

  stopMovementWatch();

  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - log.checkIn.time) / 1000));

  log.checkOut = {
    time: now,
    lat: log.checkIn.lat,
    lng: log.checkIn.lng,
    accuracy: log.checkIn.accuracy
  };
  log.workSeconds = seconds;

  await dbPut(STORE_LOGS, log);

  const flagText = (log.flags && log.flags.length) ? ` | Flags: ${log.flags.join(", ")}` : "";
  $("geoStatus").textContent = `Check-out تم بدون تقييد الموقع ✅ | ${formatDuration(seconds)}${flagText}`;
  toast("تم Check-out بنجاح.");
  return log;
}

async function getTodayLog(username) {
  const date = formatDateYMD();
  const logs = await dbGetLogsForUsername(username);
  // لأننا سجلنا ID فريد، نختار سجل اليوم بالبحث عن date
  const todays = logs.filter(l => l.date === date);
  // نأخذ آخر سجل يطابق اليوم
  todays.sort((a,b) => (b.checkIn?.time || 0) - (a.checkIn?.time || 0));
  return todays[0] || null;
}

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

async function startMovementWatch(username, date) {
  // منع تكرار watch
  stopMovementWatch();

  state.outOfRangeSince = null;
  state.lastSampleAt = 0;

  $("geoStatus").textContent = "مراقبة الحركة أثناء الدوام...";

  state.watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const now = Date.now();
      if (now - state.lastSampleAt < movementSampleEveryMs) return;
      state.lastSampleAt = now;

      const geo = computeGeoOk(pos.coords);

      // حفظ عينة حركة (للمستقبل/التدقيق)
      try {
        const sample = {
          id: `${username}_${date}_sample_${now}`,
          username,
          date,
          time: now,
          lat: geo.lat,
          lng: geo.lng,
          accuracy: pos.coords.accuracy,
          metersFromOffice: geo.metersFromOffice,
          inFence: geo.inFence
        };
        await dbPut(STORE_MOVEMENT, sample);
      } catch (e) {
        // ignore storage errors in movement sampling
      }

      // Flag من خارج الجيوفنس
      if (!geo.inFence) {
        if (!state.outOfRangeSince) state.outOfRangeSince = now;
        const outMs = now - state.outOfRangeSince;
        if (outMs >= outOfGeofenceFlagAfterMs) {
          // نحدّث flag في سجل اليوم
          const log = await getTodayLog(username);
          if (log && log.checkIn && !log.checkOut) {
            if (!log.flags.includes("OUT_OF_GEOFENCE")) {
              log.flags = log.flags || [];
              log.flags.push("OUT_OF_GEOFENCE");
              await dbPut(STORE_LOGS, log);
            }
          }
        }
      } else {
        state.outOfRangeSince = null;
      }

      // تحديث UI بسيط
      $("geoStatus").textContent = `مراقبة... المسافة ~ ${Math.round(geo.metersFromOffice)}m | accuracy=${Math.round(geo.accuracy)}m`;
    },
    (err) => {
      $("geoStatus").textContent = `تعذر مراقبة الحركة: ${err.message || err.code}`;
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

function stopMovementWatch() {
  if (state.watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.watchId);
  }
  state.watchId = null;
  state.outOfRangeSince = null;
}

function renderEmployeeView() {
  $("viewAuth").style.display = "none";
  $("viewEmployee").style.display = "block";
  $("viewAdmin").style.display = "none";
  $("btnLogout").style.display = "inline-flex";

  $("empName").textContent = state.user.username;
  $("todayStr").textContent = formatDateYMD();

  refreshEmployeeTodayCard();
  refreshEmployeeTable();
}

async function refreshEmployeeTodayCard() {
  const username = state.user.username;
  const log = await getTodayLog(username);

  if (!log) {
    $("outCheckIn").textContent = "—";
    $("outCheckOut").textContent = "—";
    $("outWork").textContent = "—";
    $("outFlags").textContent = "—";
    return;
  }

  $("outCheckIn").textContent = log.checkIn ? formatDateTime(log.checkIn.time) : "—";
  $("outCheckOut").textContent = log.checkOut ? formatDateTime(log.checkOut.time) : "—";
  $("outWork").textContent = log.workSeconds != null ? formatDuration(log.workSeconds) : "—";
  $("outFlags").textContent = (log.flags && log.flags.length) ? log.flags.join(", ") : "—";

  // disable buttons accordingly
  $("btnCheckIn").disabled = !!(log.checkIn && !log.checkOut);
  $("btnCheckOut").disabled = !(log.checkIn && !log.checkOut);
}

async function refreshEmployeeTable() {
  const username = state.user.username;
  const logs = await dbGetLogsForUsername(username);
  logs.sort((a,b) => (b.date || "").localeCompare(a.date || ""));

  const tbody = $("logsTable").querySelector("tbody");
  tbody.innerHTML = "";

  for (const l of logs.reverse()) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${l.date}</td>
      <td>${l.checkIn ? formatDateTime(l.checkIn.time) : "—"}</td>
      <td>${l.checkOut ? formatDateTime(l.checkOut.time) : "—"}</td>
      <td>${l.workSeconds != null ? formatDuration(l.workSeconds) : "—"}</td>
      <td>${(l.flags && l.flags.length) ? l.flags.join(", ") : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderAdminView() {
  $("viewAuth").style.display = "none";
  $("viewEmployee").style.display = "none";
  $("viewAdmin").style.display = "block";
  $("btnLogout").style.display = "inline-flex";

  $("adminOffice").textContent = `${office.lat}, ${office.lng}`;
  $("adminRadius").textContent = `${geofenceRadiusMeters} متر`;

  refreshAdminTable();
}

async function refreshAdminTable() {
  state.adminLogs = await dbGetAllLogs();
  const dateFilter = $("adminDateFilter").value;
  const employeeFilter = $("adminEmployeeFilter").value.trim().toLowerCase();
  const logs = state.adminLogs.filter((log) => {
    const matchesDate = !dateFilter || log.date === dateFilter;
    const matchesEmployee = !employeeFilter || log.username.toLowerCase().includes(employeeFilter);
    return matchesDate && matchesEmployee;
  }).sort((a,b) => (b.date || "").localeCompare(a.date || ""));

  const totalSeconds = state.adminLogs.reduce((sum, log) => sum + (log.workSeconds || 0), 0);
  $("adminTotalRecords").textContent = state.adminLogs.length;
  $("adminTotalHours").textContent = formatDuration(totalSeconds);
  $("adminCompletedRecords").textContent = state.adminLogs.filter((log) => log.checkOut).length;
  $("adminFlaggedRecords").textContent = state.adminLogs.filter((log) => log.flags?.includes("OUT_OF_GEOFENCE")).length;

  const tbody = $("adminTable").querySelector("tbody");
  tbody.innerHTML = "";

  for (const l of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${l.username}</td>
      <td>${l.date}</td>
      <td>${l.checkIn ? formatDateTime(l.checkIn.time) : "—"}</td>
      <td>${l.checkOut ? formatDateTime(l.checkOut.time) : "—"}</td>
      <td>${l.workSeconds != null ? formatDuration(l.workSeconds) : "—"}</td>
      <td>${(l.flags && l.flags.length) ? l.flags.join(", ") : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
  if (!logs.length) tbody.innerHTML = '<tr><td colspan="6">لا توجد سجلات مطابقة للفلاتر.</td></tr>';
}

function makeExcel(rows, sheetName="Attendance") {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const filename = `attendance_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, filename);
}

async function exportMyExcel() {
  const username = state.user.username;
  const logs = await dbGetLogsForUsername(username);
  const rows = logs.map(l => ({
    username: l.username,
    date: l.date,
    checkIn_time: l.checkIn ? new Date(l.checkIn.time).toISOString() : "",
    checkIn_lat: l.checkIn ? l.checkIn.lat : "",
    checkIn_lng: l.checkIn ? l.checkIn.lng : "",
    checkIn_accuracy_m: l.checkIn ? Math.round(l.checkIn.accuracy) : "",
    checkOut_time: l.checkOut ? new Date(l.checkOut.time).toISOString() : "",
    checkOut_lat: l.checkOut ? l.checkOut.lat : "",
    checkOut_lng: l.checkOut ? l.checkOut.lng : "",
    checkOut_accuracy_m: l.checkOut ? Math.round(l.checkOut.accuracy) : "",
    work_duration_h: l.workSeconds != null ? (l.workSeconds / 3600).toFixed(2) : "",
    flags: (l.flags && l.flags.length) ? l.flags.join(", ") : ""
  }));
  makeExcel(rows, "MyAttendance");
}

async function exportAllExcel() {
  const logs = await dbGetAllLogs();
  const rows = logs.map(l => ({
    username: l.username,
    date: l.date,
    checkIn_time: l.checkIn ? new Date(l.checkIn.time).toISOString() : "",
    checkIn_lat: l.checkIn ? l.checkIn.lat : "",
    checkIn_lng: l.checkIn ? l.checkIn.lng : "",
    checkIn_accuracy_m: l.checkIn ? Math.round(l.checkIn.accuracy) : "",
    checkOut_time: l.checkOut ? new Date(l.checkOut.time).toISOString() : "",
    checkOut_lat: l.checkOut ? l.checkOut.lat : "",
    checkOut_lng: l.checkOut ? l.checkOut.lng : "",
    checkOut_accuracy_m: l.checkOut ? Math.round(l.checkOut.accuracy) : "",
    work_duration_h: l.workSeconds != null ? (l.workSeconds / 3600).toFixed(2) : "",
    flags: (l.flags && l.flags.length) ? l.flags.join(", ") : ""
  }));
  makeExcel(rows, "AllAttendance");
}

async function clearMyData() {
  const username = state.user.username;
  const logs = await dbGetLogsForUsername(username);
  for (const l of logs) {
    await dbDelete(STORE_LOGS, l.id);
  }
  // movement samples
  const db = await openDb();
  // نعمل مسح بسيط: نحذف كل movement لمستخدم (بدون index)
  await new Promise(async (resolve) => {
    const all = await new Promise((res) => {
      const tx = db.transaction(STORE_MOVEMENT, "readonly");
      const s = tx.objectStore(STORE_MOVEMENT);
      const req = s.getAll();
      req.onsuccess = () => res(req.result || []);
    });
    // delete matching
    for (const m of all) {
      if (m.username === username) {
        await dbDelete(STORE_MOVEMENT, m.id);
      }
    }
    resolve();
  });

  toast("تم مسح بياناتي من هذا المتصفح.");
  await refreshEmployeeTable();
  await refreshEmployeeTodayCard();
}

async function clearAllData() {
  if (!state.user || state.user.role !== "admin") throw new Error("حذف السجلات متاح للـ Admin فقط.");
  stopMovementWatch();
  await dbClear(STORE_LOGS);
  await dbClear(STORE_MOVEMENT);
  toast("تم مسح كل السجلات من هذا المتصفح فقط.");
  await refreshAdminTable();
}

function showAuthRole() {
  const role = $("role").value;
  $("adminPasswordField").style.display = role === "admin" ? "block" : "none";
}

function init() {
  showAuthRole();

  $("role").addEventListener("change", showAuthRole);

  $("btnLogout").addEventListener("click", async () => {
    stopMovementWatch();
    state.user = null;
    $("btnLogout").style.display = "none";
    $("viewEmployee").style.display = "none";
    $("viewAdmin").style.display = "none";
    $("viewAuth").style.display = "block";
    $("geoStatus").textContent = "—";
  });

  $("btnLogin").addEventListener("click", async () => {
    try {
      const role = $("role").value;
      const username = $("username").value.trim();

      if (!username) throw new Error("ادخل username.");

      await ensureUser(username);

      if (role === "admin") {
        const pass = $("adminPassword").value || "";
        if (pass !== adminPassword) throw new Error("كلمة مرور Admin غير صحيحة.");
        state.user = { username, role: "admin" };
        toast("تم دخول Admin ✅");
        renderAdminView();
      } else {
        state.user = { username, role: "employee" };
        toast("تم دخول الموظف ✅");
        renderEmployeeView();
      }
    } catch (e) {
      toast(e.message || "حدث خطأ.");
    }
  });

  $("btnCheckIn").addEventListener("click", async () => {
    try {
      $("btnCheckIn").disabled = true;
      await attemptCheckIn();
      await refreshEmployeeTodayCard();
    } catch (e) {
      toast(e.message || "فشل Check-in");
    } finally {
      $("btnCheckIn").disabled = false;
    }
  });

  $("btnCheckOut").addEventListener("click", async () => {
    try {
      $("btnCheckOut").disabled = true;
      await attemptCheckOut();
      await refreshEmployeeTodayCard();
      await refreshEmployeeTable();
    } catch (e) {
      toast(e.message || "فشل Check-out");
    } finally {
      $("btnCheckOut").disabled = false;
    }
  });

  $("btnExportExcel").addEventListener("click", async () => {
    try {
      await exportMyExcel();
    } catch (e) {
      toast(e.message || "فشل التصدير.");
    }
  });

  $("btnAdminExportExcel").addEventListener("click", async () => {
    try {
      await exportAllExcel();
    } catch (e) {
      toast(e.message || "فشل التصدير.");
    }
  });

  $("btnAdminClearAll").addEventListener("click", async () => {
    if (!confirm("متأكد؟ سيتم مسح كل السجلات من هذا المتصفح فقط.")) return;
    try {
      await clearAllData();
    } catch (e) {
      toast(e.message || "فشل المسح.");
    }
  });

  $("adminDateFilter").addEventListener("input", refreshAdminTable);
  $("adminEmployeeFilter").addEventListener("input", refreshAdminTable);
  $("btnClearAdminFilters").addEventListener("click", () => {
    $("adminDateFilter").value = "";
    $("adminEmployeeFilter").value = "";
    refreshAdminTable();
  });

  initBootGeoStatus();
}

function initBootGeoStatus() {
  $("geoStatus").textContent =
    `Geofence: ${geofenceRadiusMeters}m حول المكتب | حد دقة GPS: ${maxGpsAccuracyMeters}m`;
}

init();