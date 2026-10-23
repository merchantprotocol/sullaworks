"""sullaworks-sentry: the eyes on the network.

Finds every device on the local network, fingerprints what it runs, and
reports it to the SullaWorks hub. Runs with host networking so it sees the
real LAN (ARP needs raw sockets: NET_RAW + NET_ADMIN).
"""
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

HUB_URL = (os.environ.get("HUB_URL") or "http://127.0.0.1:8770").rstrip("/")
TOKEN = os.environ.get("SULLAWORKS_TOKEN", "")
SENTRY_ID = os.environ.get("SENTRY_ID") or socket.gethostname()
SUBNET = os.environ.get("SENTRY_SUBNET", "")  # auto-detected when empty
IFACE = os.environ.get("SENTRY_IFACE", "")  # auto-detected when empty
SWEEP_EVERY = int(os.environ.get("SWEEP_EVERY", "120"))  # seconds between device sweeps
PORTS_EVERY = int(os.environ.get("PORTS_EVERY", "3600"))  # seconds between port scans of a known device
TOP_PORTS = int(os.environ.get("TOP_PORTS", "200"))
SPOOL = Path(os.environ.get("SPOOL_DIR", "/var/lib/sullaworks-sentry"))

MDNS_TYPES = [
    "_http._tcp.local.", "_https._tcp.local.", "_ssh._tcp.local.", "_smb._tcp.local.",
    "_ipp._tcp.local.", "_printer._tcp.local.", "_googlecast._tcp.local.", "_airplay._tcp.local.",
    "_raop._tcp.local.", "_hap._tcp.local.", "_companion-link._tcp.local.", "_device-info._tcp.local.",
    "_workstation._tcp.local.", "_sftp-ssh._tcp.local.", "_rtsp._tcp.local.", "_spotify-connect._tcp.local.",
]

log = logging.getLogger("sentry")


def sh(cmd, timeout=600):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0 and r.stderr:
        log.debug("%s: %s", cmd[0], r.stderr.strip()[:300])
    return r.stdout


def detect_network():
    """Default-route interface and its IPv4 subnet."""
    iface = IFACE
    if not iface:
        m = re.search(r"default via \S+ dev (\S+)", sh(["ip", "-4", "route", "show", "default"]))
        iface = m.group(1) if m else "eth0"
    subnet = SUBNET
    if not subnet:
        m = re.search(r"inet (\d+\.\d+\.\d+\.\d+/\d+)", sh(["ip", "-4", "-o", "addr", "show", "dev", iface]))
        subnet = str(ipaddress.ip_interface(m.group(1)).network) if m else ""
    return iface, subnet


# ---------------------------------------------------------------- discovery

def arp_sweep(iface, subnet):
    """ip -> {mac, vendor} from an ARP sweep (fast, sees devices that block ping)."""
    out = sh(["arp-scan", "--interface", iface, "--retry=2", "--plain", subnet], timeout=180)
    found = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and re.match(r"\d+\.\d+\.\d+\.\d+$", parts[0]):
            found[parts[0]] = {"mac": parts[1].lower(), "vendor": (parts[2] if len(parts) > 2 else "").strip()}
    return found


def ping_sweep(subnet):
    """Fallback / complement: nmap host discovery."""
    out = sh(["nmap", "-sn", "-n", "-oX", "-", subnet], timeout=300)
    found = {}
    try:
        root = ET.fromstring(out)
    except ET.ParseError:
        return found
    for host in root.findall("host"):
        ip = mac = vendor = None
        for a in host.findall("address"):
            if a.get("addrtype") == "ipv4":
                ip = a.get("addr")
            elif a.get("addrtype") == "mac":
                mac, vendor = a.get("addr", "").lower(), a.get("vendor", "")
        if ip:
            found[ip] = {"mac": mac, "vendor": vendor or ""}
    return found


class MdnsListener:
    """Passively collects names devices announce about themselves (Bonjour/mDNS)."""

    def __init__(self, iface):
        self.names = {}  # ip -> set of names/services
        self.lock = threading.Lock()
        try:
            from zeroconf import IPVersion, ServiceBrowser, Zeroconf
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", sh(["ip", "-4", "-o", "addr", "show", "dev", iface]))
            self.zc = Zeroconf(interfaces=[m.group(1)] if m else None, ip_version=IPVersion.V4Only)
            self.browsers = [ServiceBrowser(self.zc, t, handlers=[self._on]) for t in MDNS_TYPES]
        except Exception as e:  # mDNS is a bonus, never fatal
            log.warning("mDNS disabled: %s", e)
            self.zc = None

    def _on(self, zeroconf, service_type, name, state_change):
        try:
            info = zeroconf.get_service_info(service_type, name, timeout=1500)
        except Exception:
            return
        if not info:
            return
        label = name.replace("." + service_type, "")
        svc = service_type.split(".")[0].lstrip("_")
        for ip in info.parsed_addresses():
            if ":" in ip:
                continue
            with self.lock:
                self.names.setdefault(ip, set()).add(f"{label} ({svc})")

    def snapshot(self):
        with self.lock:
            return {ip: sorted(v) for ip, v in self.names.items()}


def reverse_dns(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except Exception:
        return ""


# ---------------------------------------------------------------- fingerprinting

def port_scan(ip):
    """Open TCP ports, service/version guesses, and an OS guess for one host."""
    out = sh(["nmap", "-Pn", "-n", "-sS", "-sV", "--version-light", "-O", "--osscan-limit",
              "--top-ports", str(TOP_PORTS), "-T4", "--host-timeout", "120s", "-oX", "-", ip], timeout=240)
    result = {"ports": [], "os": ""}
    try:
        root = ET.fromstring(out)
    except ET.ParseError:
        return None
    host = root.find("host")
    if host is None:
        return result
    for p in host.findall("ports/port"):
        st = p.find("state")
        if st is None or st.get("state") != "open":
            continue
        s = p.find("service")
        result["ports"].append({
            "port": int(p.get("portid")), "proto": p.get("protocol"),
            "service": s.get("name", "") if s is not None else "",
            "product": s.get("product", "") if s is not None else "",
            "version": s.get("version", "") if s is not None else "",
        })
    m = host.find("os/osmatch")
    if m is not None:
        result["os"] = f"{m.get('name')} ({m.get('accuracy')}%)"
    return result


# ---------------------------------------------------------------- hub

def post(path, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(HUB_URL + path, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def send(payload):
    """Deliver to the hub; spool to disk if it is unreachable and retry later."""
    SPOOL.mkdir(parents=True, exist_ok=True)
    pending = sorted(SPOOL.glob("*.json"))
    for f in pending:
        try:
            post("/api/ingest", json.loads(f.read_text()))
            f.unlink()
        except Exception as e:
            log.warning("hub still unreachable (%s); %d report(s) waiting", e, len(pending))
            break
    try:
        return post("/api/ingest", payload)
    except Exception as e:
        log.warning("hub unreachable (%s); spooling report", e)
        (SPOOL / f"{time.time_ns()}.json").write_text(json.dumps(payload))
        for old in sorted(SPOOL.glob("*.json"))[:-500]:  # keep the spool bounded
            old.unlink()
        return None


# ---------------------------------------------------------------- main loop

def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    if not TOKEN:
        log.warning("SULLAWORKS_TOKEN is empty; the hub will reject reports")
    iface, subnet = detect_network()
    log.info("sentry %s watching %s on %s, reporting to %s", SENTRY_ID, subnet, iface, HUB_URL)
    mdns = MdnsListener(iface)
    last_ports = {}
    while True:
        started = time.time()
        found = arp_sweep(iface, subnet)
        for ip, v in ping_sweep(subnet).items():
            found.setdefault(ip, v)
            if not found[ip].get("mac") and v.get("mac"):
                found[ip].update(v)
        names = mdns.snapshot()
        devices = [{"ip": ip, "mac": v.get("mac") or None, "vendor": v.get("vendor", ""),
                    "hostname": reverse_dns(ip), "mdns": names.get(ip, [])} for ip, v in sorted(found.items())]
        send({"sentry": SENTRY_ID, "iface": iface, "subnet": subnet, "kind": "sweep",
              "at": time.time(), "duration": round(time.time() - started, 1), "devices": devices})
        log.info("sweep: %d devices in %.1fs", len(devices), time.time() - started)

        # Port-scan new devices first, then refresh the stalest, a few per cycle.
        due = [d for d in devices if time.time() - last_ports.get(d["ip"], 0) > PORTS_EVERY]
        due.sort(key=lambda d: last_ports.get(d["ip"], 0))
        budget = time.time() + max(30, SWEEP_EVERY - 20)
        for d in due:
            if time.time() > budget:
                break
            res = port_scan(d["ip"])
            if res is None:
                continue
            last_ports[d["ip"]] = time.time()
            send({"sentry": SENTRY_ID, "kind": "ports", "at": time.time(),
                  "device": {"ip": d["ip"], "mac": d["mac"]}, **res})
            log.info("ports %s: %s", d["ip"], ",".join(str(p["port"]) for p in res["ports"]) or "none open")
        time.sleep(max(5, SWEEP_EVERY - (time.time() - started)))


if __name__ == "__main__":
    main()
