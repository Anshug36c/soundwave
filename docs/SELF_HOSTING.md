# Running SoundWave on your own device

Free, no credit card, no egress bill, no free-tier sleep, and no platform can
suspend it. Your machine already has everything the app needs — it boots at
**42 MB RSS** with all three provider indexes loaded, and it writes nothing to
disk (likes/playlists live in the browser, caches are ephemeral by design).

The trade-off is honest and simple: **the device has to be on** for the site to
be up, and audio streams out over your home upload connection.

---

## Step 1 — Run it (same for every option below)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(Windows/macOS) or Docker Engine (Linux), then from the repo root:

```bash
docker compose up -d --build
```

Open **http://localhost:5000**. That's the whole app — search, playback, EQ,
lyrics, offline saves.

Useful commands:

```bash
docker compose logs -f        # watch logs
docker compose restart        # restart after a config change
docker compose down           # stop
docker compose up -d --build  # rebuild after pulling new code
```

Check it's healthy — wait for non-zero `indexes` before judging search speed,
because the 85k tracks load from the providers after boot:

```bash
curl http://localhost:5000/api/health
```

Keep the app updated:

```bash
git pull && docker compose up -d --build
```

---

## Step 2 — Decide how far it needs to reach

### Option A — Just you, on your home Wi-Fi (simplest)

Nothing more to do. From your phone on the same Wi-Fi, open
`http://<your-computer's-LAN-IP>:5000`.

Find your LAN IP with `ipconfig` (Windows) or `ip addr` / `hostname -I`
(Linux/macOS). It looks like `192.168.1.x`.

This works for everything except Google sign-in, which Google only allows on
`http://localhost` or an HTTPS origin.

### Option B — Reachable from anywhere: Cloudflare Tunnel (recommended)

Best choice if you want to share it or use it away from home. The tunnel makes
an **outbound** connection to Cloudflare, so there is **no port forwarding, no
router config, and no public IP** — which matters because most Indian ISPs
(Jio, Airtel) put home connections behind CGNAT, where port forwarding simply
does not work.

You need a free Cloudflare account and a domain on it (any cheap domain works).

```bash
cloudflared tunnel login
cloudflared tunnel create soundwave
cloudflared tunnel route dns soundwave soundwave.yourdomain.com
```

Then run a tunnel alongside the app — add this to `docker-compose.yml` under
`services:`:

```yaml
  tunnel:
    image: cloudflare/cloudflared:latest
    container_name: soundwave-tunnel
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: <token from the Cloudflare Zero Trust dashboard>
    depends_on:
      - soundwave
```

Get `TUNNEL_TOKEN` from **Zero Trust → Networks → Tunnels → your tunnel →
Configure**, and set its public hostname to point at `http://soundwave:5000`.

Result: `https://soundwave.yourdomain.com`, with automatic HTTPS and Range
request support, so seeking works.

For sign-in, set `GOOGLE_CLIENT_ID` and `SESSION_SECRET` in `docker-compose.yml`
and add `https://soundwave.yourdomain.com` to the OAuth client's Authorized
JavaScript origins.

### Option C — Tailscale Funnel (no domain needed)

If you don't own a domain, Tailscale can expose the port publicly with automatic
HTTPS on a `*.ts.net` hostname:

```bash
tailscale funnel 5000
```

Simpler than a tunnel, no domain to buy. Free for personal use.

### Option D — Port forwarding + DDNS (only if your ISP gives you a public IP)

Forward port 80/443 to your machine, point a DDNS hostname at it, and put Caddy
in front for automatic TLS. Workable, but you have to check first that your ISP
actually gives you a public IP and does not block port 80 — many do not and do.
Prefer Option B.

---

## Keeping it alive

Docker's `restart: unless-stopped` handles crashes and reboots (as long as
Docker itself starts on boot — enable that in Docker Desktop settings).

For a machine that suspends when idle, disable sleep, or on Linux:

```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

---

## Realistic expectations

- **Upload bandwidth is your ceiling.** A 4-minute track at 320 kbps is roughly
  10 MB. On a 20 Mbps upload you can comfortably serve a few concurrent
  listeners; it is not a CDN. Fine for you and a handful of friends.
- **Latency.** Serving from home in India to users in India will actually be
  *faster* than any US-region free tier.
- **Uptime.** It is up when your machine is up. If that is not acceptable, a
  free cloud tier is the alternative — but every one of them either sleeps,
  needs a card, or bills you for egress.
- **Your ISP's terms.** Residential connections often prohibit running servers.
  Low-traffic personal use is rarely an issue, but it is worth knowing.
- **Exposing a port to the internet** means the whole internet can reach your
  server. Option B and C keep the port closed and route through TLS; Option D
  does not.
