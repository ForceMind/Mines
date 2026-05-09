# Mines

Server-side Mines game with an English 1:1 frontend, an admin page, and RTP protection controls.

## Run

```bash
npm start
```

Open:

- Game: `http://127.0.0.1:3000`
- Admin: `http://127.0.0.1:3000/admin`

## Linux Deployment

Run this from the project directory on the server:

```bash
sudo sh deploy-linux.sh
```

The script supports common Linux package managers including `apt`, `dnf`, `yum`, `zypper`, `pacman`, and `apk`. It checks git upstream updates, installs Node.js 18+, detects port conflicts, copies the app to `/opt/mines`, creates a service user, writes `/etc/mines.env`, and registers a systemd or OpenRC service when available.

Useful overrides:

```bash
sudo APP_DIR=/opt/mines PORT=3000 HOST=0.0.0.0 sh deploy-linux.sh
```

## Server Logic

- Each click is decided on the server with the current mine probability.
- The client sends only player actions: start, reveal, cash out, abandon, and deposit.
- Player RTP is tracked as `totalPaidOut / totalWagered`.
- When a player's RTP is below the protection floor and a click would normally lose, the server can apply the configured protection deviation and return a safe result instead.
- Protection only applies when the cashout value after that safe result would still keep the player's cumulative RTP at or below the configured maximum.
- Payouts are capped so the player's cumulative RTP cannot exceed the configured maximum RTP, which defaults to `100%`.

## Files

- `server.js` - HTTP server, APIs, game state, RTP logic, admin APIs.
- `index.html` - English 1:1 game UI.
- `admin.html` - runtime admin dashboard and protection settings.
- `deploy-linux.sh` - one-command Linux deployment script.
