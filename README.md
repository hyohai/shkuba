# Shkuba / Scopa — Multiplayer Card Game

A real-time multiplayer Scopa (Shkuba) game for 2–4 players. Works on local WiFi **and** remotely over the internet via a free Cloudflare tunnel.

## Requirements

- Node.js (v16 or later)
- npm

## Setup

```bash
cd scopa
npm install
node server.js
```

The server starts on port 3000.

---

## Playing on local WiFi (same network)

1. Find your Pi's IP: `hostname -I`
2. Everyone opens `http://<pi-ip>:3000` on their phone/browser.

---

## Playing remotely over the internet (Cloudflare Tunnel)

Cloudflare Tunnel is free, requires no account, and creates a public HTTPS URL that tunnels to your local server. No port forwarding or router config needed.

### Install cloudflared on the Pi (one time)

```bash
# For Raspberry Pi (ARM):
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
chmod +x cloudflared-linux-arm64
sudo mv cloudflared-linux-arm64 /usr/local/bin/cloudflared
```

For older Pi (32-bit): use `cloudflared-linux-arm` instead of `arm64`.

### Run the tunnel

```bash
# Terminal 1: start the game server
node server.js

# Terminal 2: open the tunnel
cloudflared tunnel --url http://localhost:3000
```

Cloudflare will print a URL like:
```
https://random-words-here.trycloudflare.com
```

Share that URL with your players via WhatsApp, SMS, etc. **The URL changes each time you restart the tunnel** — that's normal for the free tier.

### Tip: pin a permanent URL (optional, free Cloudflare account)
If you want the same URL every time, create a free Cloudflare account and set up a named tunnel. See: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

---

3. One player taps **Host Game** → a 4-digit room code appears.

4. Other players go to the same URL, enter their name and the code, tap **Join**.

5. The host taps **Start Game** when everyone is in (2–4 players).

## Game Rules (as configured)

- **Deck**: 40 cards, values 1–10 (Q=8, J=9, K=10), suits: coins, cups, swords, clubs
- **Deal**: 4 cards to the table, 3 cards to each player. Re-deal when hands are empty.
- **Turn**: Play one card — capture table cards that sum to your card's value, or trail (leave on table). You **must** capture if possible.
- **Scopa**: Clearing the table earns a Scopa bonus point (except on the very last play).
- **Round end**: Last player to capture takes remaining table cards.

### Scoring per round
| Point | Condition |
|-------|-----------|
| Carte | Most cards captured (no point if tied) |
| Denari | Most coins/diamonds captured (no point if tied) |
| Settebello | Holds the 7 of coins |
| Sevens | Most 7s captured; tiebreak by most 6s among tied players; no point if still tied |
| Scopa | +1 per table clear |

### Winning
First player to reach **21+ points** with a **2-point lead** over second place wins.

### Shuffle & Cut ceremony
- The **dealer** shuffles (taps button on their device).
- The **player before the dealer** cuts the deck (taps button on their device).
- The dealer rotates clockwise each round.

## Auto-start on boot (optional)

Create `/etc/systemd/system/scopa.service`:
```ini
[Unit]
Description=Scopa Card Game
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/scopa/server.js
WorkingDirectory=/path/to/scopa
Restart=always
User=pi
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable scopa
sudo systemctl start scopa
```
