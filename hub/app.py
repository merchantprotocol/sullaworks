"""sullaworks: the hub.

Receives reports from sentries, keeps the device inventory, records what
changed (new device, went offline, port opened...), and serves the live view.
"""
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

DB_PATH = Path(os.environ.get("DB_PATH", "/data/sullaworks.db"))
TOKEN = os.environ.get("SULLAWORKS_TOKEN", "")
OFFLINE_AFTER = int(os.environ.get("OFFLINE_AFTER", "600"))  # seconds unseen before a device counts as offline
STATIC = Path(__file__).parent / "static"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sentries (
  id TEXT PRIMARY KEY, iface TEXT, subnet TEXT, first_seen REAL, last_seen REAL, last_sweep_devices INTEGER
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,          -- mac address, or ip:<addr> when no mac is visible
  mac TEXT, ip TEXT, vendor TEXT, hostname TEXT, names TEXT DEFAULT '[]', os TEXT,
  label TEXT,                        -- a human-given name, never overwritten by scans
  sentry TEXT, first_seen REAL, last_seen REAL, ports_scanned REAL, online INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ports (
  device_id INTEGER NOT NULL REFERENCES devices(id), port INTEGER NOT NULL, proto TEXT NOT NULL,
  service TEXT, product TEXT, version TEXT, first_seen REAL, last_seen REAL, open INTEGER DEFAULT 1,
  PRIMARY KEY (device_id, port, proto)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, device_id INTEGER, kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info', detail TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at DESC);
"""

# Ports that deserve a louder event when they open.
RISKY = {21: "FTP", 23: "Telnet", 445: "SMB", 1433: "MS SQL", 3306: "MySQL", 3389: "Remote Desktop",
         5432: "Postgres", 5900: "VNC", 6379: "Redis", 9200: "Elasticsearch", 27017: "MongoDB"}

_lock = threading.Lock()


@contextmanager
def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


with db() as c:
    c.executescript(SCHEMA)

app = FastAPI(title="SullaWorks hub")


def require_token(authorization: str = Header(default="")):
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="bad or missing sentry token")


def event(c, device_id, kind, detail, severity="info", at=None):
    c.execute("INSERT INTO events(at, device_id, kind, severity, detail) VALUES (?,?,?,?,?)",
              (at or time.time(), device_id, kind, severity, detail))


def device_name(row):
    return row["label"] or row["hostname"] or (json.loads(row["names"] or "[]") or [None])[0] or row["vendor"] or row["ip"]


def find_device(c, mac, ip):
    if mac:
        r = c.execute("SELECT * FROM devices WHERE key=?", (mac,)).fetchone()
        if r:
            return r
    return c.execute("SELECT * FROM devices WHERE key=?", (f"ip:{ip}",)).fetchone() or \
        c.execute("SELECT * FROM devices WHERE ip=? ORDER BY last_seen DESC LIMIT 1", (ip,)).fetchone()


def ingest_sweep(c, rep):
    now = rep.get("at") or time.time()
    sentry = rep["sentry"]
    c.execute("""INSERT INTO sentries(id, iface, subnet, first_seen, last_seen, last_sweep_devices) VALUES (?,?,?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET iface=excluded.iface, subnet=excluded.subnet,
                 last_seen=excluded.last_seen, last_sweep_devices=excluded.last_sweep_devices""",
              (sentry, rep.get("iface"), rep.get("subnet"), now, now, len(rep.get("devices", []))))
    first_sweep = c.execute("SELECT COUNT(*) FROM devices WHERE sentry=?", (sentry,)).fetchone()[0] == 0
    seen = set()
    for d in rep.get("devices", []):
        mac, ip = d.get("mac"), d["ip"]
        key = mac or f"ip:{ip}"
        names = json.dumps(d.get("mdns") or [])
        row = find_device(c, mac, ip)
        if row is None:
            cur = c.execute("""INSERT INTO devices(key, mac, ip, vendor, hostname, names, sentry, first_seen, last_seen, online)
                               VALUES (?,?,?,?,?,?,?,?,?,1)""",
                            (key, mac, ip, d.get("vendor"), d.get("hostname"), names, sentry, now, now))
            row = c.execute("SELECT * FROM devices WHERE id=?", (cur.lastrowid,)).fetchone()
            if not first_sweep:  # everything is "new" on the very first sweep; only announce later arrivals
                event(c, row["id"], "new_device", f"{device_name(row)} joined the network at {ip}"
                      + (f" ({d.get('vendor')})" if d.get("vendor") else ""), "warn", now)
        else:
            if row["ip"] != ip:
                event(c, row["id"], "ip_changed", f"{device_name(row)} moved from {row['ip']} to {ip}", "info", now)
            if not row["online"]:
                event(c, row["id"], "back_online", f"{device_name(row)} is back online at {ip}", "info", now)
            merged = sorted(set(json.loads(row["names"] or "[]")) | set(d.get("mdns") or []))
            c.execute("""UPDATE devices SET key=?, mac=COALESCE(?, mac), ip=?, vendor=COALESCE(NULLIF(?, ''), vendor),
                         hostname=COALESCE(NULLIF(?, ''), hostname), names=?, sentry=?, last_seen=?, online=1 WHERE id=?""",
                      (key if mac else row["key"], mac, ip, d.get("vendor"), d.get("hostname"), json.dumps(merged),
                       sentry, now, row["id"]))
        seen.add(row["id"])
    # Anything this sentry used to see that has been quiet too long is offline.
    for r in c.execute("SELECT * FROM devices WHERE sentry=? AND online=1 AND last_seen < ?", (sentry, now - OFFLINE_AFTER)).fetchall():
        if r["id"] in seen:
            continue
        c.execute("UPDATE devices SET online=0 WHERE id=?", (r["id"],))
        event(c, r["id"], "offline", f"{device_name(r)} went offline (last seen at {r['ip']})", "info", now)
    return {"devices": len(seen)}


def ingest_ports(c, rep):
    now = rep.get("at") or time.time()
    d = rep["device"]
    row = find_device(c, d.get("mac"), d["ip"])
    if row is None:
        return {"ignored": "unknown device"}
    first_scan = row["ports_scanned"] is None
    c.execute("UPDATE devices SET ports_scanned=?, os=COALESCE(NULLIF(?, ''), os) WHERE id=?", (now, rep.get("os"), row["id"]))
    current = {(p["port"], p["proto"]): p for p in rep.get("ports", [])}
    known = {(r["port"], r["proto"]): r for r in c.execute("SELECT * FROM ports WHERE device_id=?", (row["id"],))}
    for k, p in current.items():
        label = f"{p['port']}/{p['proto']}" + (f" {p['service']}" if p.get("service") else "")
        if k not in known or not known[k]["open"]:
            c.execute("""INSERT INTO ports(device_id, port, proto, service, product, version, first_seen, last_seen, open)
                         VALUES (?,?,?,?,?,?,?,?,1) ON CONFLICT(device_id, port, proto) DO UPDATE SET
                         service=excluded.service, product=excluded.product, version=excluded.version, last_seen=excluded.last_seen, open=1""",
                      (row["id"], p["port"], p["proto"], p.get("service"), p.get("product"), p.get("version"), now, now))
            if not first_scan:
                risky = RISKY.get(p["port"])
                event(c, row["id"], "port_opened", f"{device_name(row)} opened {label}" + (f" ({risky})" if risky else ""),
                      "bad" if risky else "warn", now)
        else:
            c.execute("UPDATE ports SET service=?, product=?, version=?, last_seen=? WHERE device_id=? AND port=? AND proto=?",
                      (p.get("service"), p.get("product"), p.get("version"), now, row["id"], p["port"], p["proto"]))
    for k, r in known.items():
        if r["open"] and k not in current:
            c.execute("UPDATE ports SET open=0 WHERE device_id=? AND port=? AND proto=?", (row["id"], r["port"], r["proto"]))
            event(c, row["id"], "port_closed", f"{device_name(row)} closed {r['port']}/{r['proto']}", "info", now)
    if first_scan:
        risky = [f"{p['port']} ({RISKY[p['port']]})" for p in current.values() if p["port"] in RISKY]
        if risky:
            event(c, row["id"], "risky_ports", f"{device_name(row)} has risky ports open: {', '.join(risky)}", "bad", now)
    return {"open_ports": len(current)}


@app.post("/api/ingest", dependencies=[Depends(require_token)])
def ingest(rep: dict):
    with _lock, db() as c:
        if rep.get("kind") == "sweep":
            return ingest_sweep(c, rep)
        if rep.get("kind") == "ports":
            return ingest_ports(c, rep)
    raise HTTPException(status_code=400, detail="unknown report kind")


def device_dict(c, r):
    ports = [dict(p) for p in c.execute(
        "SELECT port, proto, service, product, version, first_seen FROM ports WHERE device_id=? AND open=1 ORDER BY port", (r["id"],))]
    out = dict(r)
    out["names"] = json.loads(r["names"] or "[]")
    out["name"] = device_name(r)
    out["ports"] = ports
    out["risky"] = [p["port"] for p in ports if p["port"] in RISKY]
    return out


@app.get("/api/devices")
def devices():
    with db() as c:
        return [device_dict(c, r) for r in c.execute("SELECT * FROM devices ORDER BY online DESC, ip")]


@app.get("/api/devices/{device_id}")
def device(device_id: int):
    with db() as c:
        r = c.execute("SELECT * FROM devices WHERE id=?", (device_id,)).fetchone()
        if not r:
            raise HTTPException(404)
        out = device_dict(c, r)
        out["events"] = [dict(e) for e in c.execute("SELECT * FROM events WHERE device_id=? ORDER BY at DESC LIMIT 50", (device_id,))]
        return out


@app.post("/api/devices/{device_id}/label")
def set_label(device_id: int, body: dict):
    with _lock, db() as c:
        c.execute("UPDATE devices SET label=? WHERE id=?", ((body.get("label") or "").strip() or None, device_id))
    return {"ok": True}


@app.get("/api/events")
def events(limit: int = Query(100, le=1000), since: float = 0):
    with db() as c:
        rows = c.execute("""SELECT e.*, d.ip, COALESCE(d.label, d.hostname, d.vendor, d.ip) AS device
                            FROM events e LEFT JOIN devices d ON d.id = e.device_id
                            WHERE e.at > ? ORDER BY e.at DESC LIMIT ?""", (since, limit))
        return [dict(r) for r in rows]


@app.get("/api/summary")
def summary():
    with db() as c:
        q = lambda sql, *a: c.execute(sql, a).fetchone()[0]
        day = time.time() - 86400
        return {
            "devices": q("SELECT COUNT(*) FROM devices"),
            "online": q("SELECT COUNT(*) FROM devices WHERE online=1"),
            "new_today": q("SELECT COUNT(*) FROM devices WHERE first_seen > ?", day),
            "open_ports": q("SELECT COUNT(*) FROM ports WHERE open=1"),
            "risky_ports": q(f"SELECT COUNT(*) FROM ports WHERE open=1 AND port IN ({','.join(map(str, RISKY))})"),
            "sentries": [dict(r) for r in c.execute("SELECT * FROM sentries ORDER BY last_seen DESC")],
            "now": time.time(),
        }


@app.get("/healthz")
def healthz():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")
