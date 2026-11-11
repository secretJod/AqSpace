# Runbook: run AQspace on a second Mac (Apple Silicon) over SSH

Card #136. "This Mac" is the developer machine with the repo. "The target" is the second Mac (M1).
Deploys use `scripts/deploy.sh`. Nothing is installed globally on this Mac. On the target, everything
lives inside one repo folder (default `~/AQspace`), so deleting that folder removes the app.

## 1. One-time setup on the target Mac

### 1.1 User and Remote Login
1. Use a dedicated standard (non-admin) user if possible, for example `aqspace`.
2. System Settings > General > Sharing > **Remote Login**: on. Under (i), allow access for **only this user**.
3. Note the address: `hostname` (for example `target-mac.local`) or its LAN IP (System Settings > Network). Reserve the IP in the router (DHCP reservation) so it does not change.

### 1.2 SSH key from this Mac
On this Mac:
```bash
ssh-keygen -t ed25519 -C "aqspace-deploy" -f ~/.ssh/aqspace_ed25519   # set a passphrase
ssh-copy-id -i ~/.ssh/aqspace_ed25519.pub aqspace@target-mac.local
```
Add this to `~/.ssh/config` on this Mac so `deploy.sh` (which uses `BatchMode`, so it never prompts for a password) finds the key:
```
Host aqspace-target
  HostName target-mac.local
  User aqspace
  IdentityFile ~/.ssh/aqspace_ed25519
  IdentitiesOnly yes
```
Check: `ssh aqspace-target 'echo ok'` must work without a password prompt.

### 1.3 Disable password login (only after 1.2 works)
On the target, create `/etc/ssh/sshd_config.d/100-aqspace.conf` with `sudo`:
```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```
Then turn Remote Login off and on again (or run `sudo launchctl kickstart -k system/com.openssh.sshd`).
Keep your current SSH session open and check that a new key login works before you close it.

### 1.4 Docker Desktop with a memory cap
1. Install Docker Desktop for Mac (Apple Silicon) from docker.com.
2. Settings > Resources: memory **6 GB** on a 16 GB M1 (4 GB on an 8 GB M1), 4 CPUs, a 64 GB disk limit. This leaves room for macOS and a future native llama.cpp server.
3. Settings > General: turn on **Start Docker Desktop when you sign in**. Docker Desktop runs only while the deploy user is signed in, so turn on automatic login for that user or keep it signed in.
4. Check over SSH: `ssh aqspace-target 'PATH=/usr/local/bin:$PATH docker info >/dev/null && echo docker ok'`.

`rsync` and `curl` ship with macOS. `deploy.sh` does not need git on the target.

### 1.5 Repo location
The app lives in `~/AQspace` on the target (change it with `--dir`). All state stays inside it:
`.data/` (Postgres, plus deploy state in `.data/deploy/`), `aq-api/data/`, `lecture-notes-ai/backend/.tmp/` and the `.env` files.
Running `scripts/nuke.sh` on the target wipes all of it. No named Docker volumes are used.

### 1.6 Firewall
System Settings > Network > Firewall: **on**. In Options, turn on **stealth mode**. Compose publishes its ports on `127.0.0.1` only, so nothing from Docker is reachable from the LAN. SSH (port 22) is the only service open to the network.

### 1.7 Keep the Mac awake
```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1
pmset -g    # check the settings
```
`autorestart 1` brings the Mac back after a power cut. With automatic login and Docker's start-at-sign-in setting, the containers come back too (they have `restart:` policies).
To keep it awake only for a while instead, run `caffeinate -dimsu` in a terminal on the target.

## 2. Deploying from this Mac
```bash
scripts/deploy.sh aqspace-target --dry-run              # print every step, change nothing
scripts/deploy.sh aqspace-target --with-secrets         # first deploy: also copy the .env files (chmod 600)
scripts/deploy.sh aqspace-target origin/preview/latest  # update to a ref (secrets are already there)
scripts/deploy.sh aqspace-target --status               # deployed ref, containers, health
scripts/deploy.sh aqspace-target --rollback             # redeploy the previous ref
```
How it works:
1. `git archive` exports the ref (tracked files only, so secrets never travel through git) into `.run/deploy-stage`.
2. rsync copies it into `~/AQspace` with `--delete`, keeping `.env`, `.data/`, `.tmp/`, `models/` and `aq-api/data/` on the target.
3. With `--with-secrets`, the two `.env` files are streamed over SSH stdin into files with mode 600. Their contents are never printed or put on a command line.
4. `docker compose up -d --build` runs on the target, then the script waits for `/api/v1/health`.
5. The deployed SHA is written to `.data/deploy/current`, the one before it to `.data/deploy/previous`, and each deploy is appended to `.data/deploy/history`.

Notes:
- Rollback switches to `previous`. Running it twice returns you to where you started.
- The ref must exist in this local repo, so run `git fetch` first.
- `--profile tunnel` also starts the Cloudflare tunnel (see 3.2).
- Deploying the same ref again is safe (idempotent).
- The local model server (llama.cpp) is not part of this yet. The notes provider set in `.env` (for example Gemini) is used.

## 3. Access options

### 3.1 SSH port-forward (recommended)
The app listens only on the target's `127.0.0.1:5180`. From any machine whose key is on the target:
```bash
ssh -N -L 5180:127.0.0.1:5180 aqspace-target
# then open http://localhost:5180
```
- Pros: no new open port; traffic is encrypted and key-authenticated; the Google OAuth redirect stays `http://localhost:5180`, so the OAuth console needs no change.
- Cons: every user needs an SSH key on the target. That suits the team and QA, not public users.

### 3.2 Cloudflare tunnel (public access)
```bash
scripts/deploy.sh aqspace-target --profile tunnel
ssh aqspace-target 'cd AQspace && PATH=/usr/local/bin:$PATH docker compose logs tunnel | grep trycloudflare'
```
- Pros: anyone with the URL can use it, with no router port-forwarding and no inbound port on the Mac.
- Cons: the app is on the public internet, so its own sign-in is the only gate. A quick-tunnel URL changes on every restart, so OAuth redirect URIs break (a named tunnel with a fixed hostname fixes this). Traffic passes through Cloudflare.

**Recommendation:** use the SSH port-forward for the team and QA now. Move to the tunnel only when outside users must try the app, and then use a named tunnel with a fixed hostname registered as an OAuth redirect URI, with sign-in required on every route.

Do not change the compose ports to `0.0.0.0` to expose the app on the LAN: it is plain HTTP without TLS.

## 4. Troubleshooting
- `Permission denied (publickey)`: check `~/.ssh/config` and step 1.2.
- `Docker Desktop is not installed/running`: install it, or sign in as the deploy user so it starts (1.4).
- Health timeout: deploy.sh prints the last 40 log lines. Also try `--status`.
- `missing .env on target`: rerun with `--with-secrets`.
