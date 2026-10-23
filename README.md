# SullaWorks

AI-run network security, in two containers.

| Container | Image | Job |
|---|---|---|
| **sullaworks** (the hub) | `ghcr.io/merchantprotocol/sullaworks` | Keeps the device inventory and the history of what changed, and serves the live view on port 8770. |
| **sullaworks-sentry** (the eyes) | `ghcr.io/merchantprotocol/sullaworks-sentry` | Sweeps the local network, fingerprints every device, and reports to the hub. |

## What the sentry sees today

- **Every device on the LAN.** ARP sweep (catches devices that ignore ping) plus nmap host discovery.
- **What each device is.** MAC vendor, reverse DNS name, and the names devices announce over mDNS/Bonjour.
- **What each device runs.** Open TCP ports with service and version guesses, and an OS guess (nmap, top 200 ports by default).

The hub turns those reports into events: a new device joined, a device went offline or came back, an IP changed, a port opened or closed, and risky ports (Telnet, SMB, RDP, databases, VNC…) that are open.

## Run it

Run both containers on an **always-on machine on the network you want to watch**. The sentry uses host networking and needs `NET_RAW`/`NET_ADMIN` to send ARP packets.

```sh
cp .env.example .env    # set SULLAWORKS_TOKEN (openssl rand -hex 32)
docker compose up -d
open http://<that-machine>:8770
```

The sentry finds its subnet from the default route. Set `SENTRY_SUBNET` / `SENTRY_IFACE` to override. If the hub is down, the sentry spools reports to disk and delivers them later.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/ingest` | Sentry reports (`Authorization: Bearer $SULLAWORKS_TOKEN`) |
| GET | `/api/summary` | Counts and sentry status |
| GET | `/api/devices`, `/api/devices/{id}` | Inventory with open ports and history |
| POST | `/api/devices/{id}/label` | Give a device a human name |
| GET | `/api/events?since=&limit=` | What changed |

## Images

Each image rebuilds automatically when its own folder changes on `main` (`.github/workflows/hub.yml`, `.github/workflows/sentry.yml`), for amd64 and arm64.
