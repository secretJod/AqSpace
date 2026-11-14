# Runbook: AQspace on Mac B (Colima)

Cards #136 (first runbook) and #161 (CI/CD). Owner: `devops`.
"Mac A" is the developer Mac with the repo. "Mac B" is the deployed Mac.
Secrets are never printed, pasted or committed. They move only by `scp`.

## 1. The machine

| Item | Value |
|---|---|
| Name | Karans-MacBook-Air (Apple Silicon, 8 GB RAM) |
| User | `secret` |
| Address | `Karans-MacBook-Air.local` (mDNS). The IP changes with the network (was 10.187.71.212, now 192.168.1.89), so never use the IP. |
| Host fingerprint | `SHA256:bZ2/aDnPqBSlSdOJNRxrRypIM9t/Tv74CRgK8abVzFk` |
| Docker | Colima: aarch64, 4 CPUs, 6 GB memory, 100 GB disk, docker runtime, virtiofs mounts. Docker Desktop is installed but NOT used. |
| App folder | `~/AQspace` (a git clone) |
| Secrets | `~/AQspace/.env` and `~/AQspace/lecture-notes-ai/backend/.env`, mode 600. `AUTH_MODE=local`. |

## 2. SSH from Mac A

The alias `aqspace-macb` in `~/.ssh/config` on Mac A looks like this:
```
Host aqspace-macb
  HostName Karans-MacBook-Air.local
  User secret
  IdentityFile ~/.ssh/aqspace_macb
  IdentitiesOnly yes
```

To check the connection, run this on Mac A:
```bash
ssh aqspace-macb 'echo ok'
```

Docker is not on PATH in a non-login SSH shell. Start every remote command with this line:
```bash
export PATH=$PATH:/opt/homebrew/bin:/usr/local/bin
```

## 3. Colima (one-time setup, already done)

To see Colima's status and resources, run this on Mac B:
```bash
colima status
```

To start Colima with the agreed resources (never more than 6 GB memory on this 8 GB Mac), run this on Mac B:
```bash
colima start --cpu 4 --memory 6 --disk 100 --vm-type vz --mount-type virtiofs
```

To make Colima start by itself at login, run this on Mac B:
```bash
brew services start colima
```

## 4. Keep Mac B awake

Mac B must stay on its charger. On battery it goes to sleep and the app stops answering.

To stop it sleeping while on the charger, run this on Mac B:
```bash
sudo pmset -c sleep 0
```

To check the setting (look for `sleep 0` under AC Power), run this on Mac B:
```bash
pmset -g custom
```

## 5. The first deploy (what was done, 2026-11-15)

1. `~/AQspace` was cloned from `preview/latest` at commit `1e93064`.
2. Both `.env` files were copied from Mac A with `scp`, then `chmod 600`. `AUTH_MODE=local`.
3. The other project on Mac B, **urlshortener** (api, grafana, nginx, prometheus, postgres, redis, mailhog), was **stopped, not deleted**, at the user's request, so AQspace gets all of Colima's memory.
4. `docker compose up -d --build` was run. The first try failed with exit 137 because a build step container was stopped by mistake (see section 11). The rebuild succeeded.
5. Smoke test passed: deep health `"ok":true`, UI 200, `/package.json` 404, a playlist imported, notes for video `9vKqVkMQHKk` ready in 15 s, PDF 200 (664 KB).
6. The Cloudflare quick tunnel was started (section 8).

## 6. Update to a new commit

Deploy only code that passed QA (`main`, or the branch the user names). Never a pull request's code.

Open a shell on Mac B from Mac A:
```bash
ssh aqspace-macb
```

Go to the app folder on Mac B:
```bash
cd ~/AQspace
```

Write down the commit that runs now, so you can roll back to it:
```bash
git rev-parse --short HEAD
```

Get the new code on Mac B:
```bash
git pull
```

Rebuild and restart in the background, so a dropped SSH connection does not cancel the build. Run this on Mac B:
```bash
nohup docker compose up -d --build > deploy.log 2>&1 &
```

Follow the build until it finishes, on Mac B (Ctrl+C stops only the viewing, not the build):
```bash
tail -f deploy.log
```

Check health on Mac B (wait for `"ok":true`):
```bash
curl -s 'localhost:5180/api/v1/health?deep=1'
```

Check the UI answers 200, on Mac B:
```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:5180/
```

Check source files are not served (must be 404), on Mac B:
```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:5180/package.json
```

After a successful deploy, free old images on Mac B (never volumes or `.data`):
```bash
docker image prune -f
```

If any check fails, roll back (section 9).

## 7. Progress and logs

To see which containers run and whether they are healthy, run this on Mac B:
```bash
docker compose ps
```

To follow the logs of all services, run this on Mac B:
```bash
docker compose logs -f --tail 100
```

To see memory and CPU use, run this on Mac B:
```bash
docker stats --no-stream
```

**Never stop containers with random names** (like `elated_wilson`) while a build runs. The classic builder runs each build step in a temporary container with a random name. Stopping one kills the build with exit 137.

## 8. The live URL (Cloudflare quick tunnel)

To start the tunnel, run this on Mac B:
```bash
docker compose --profile tunnel up -d tunnel
```

To get the current public URL, run this on Mac B:
```bash
docker compose logs tunnel | grep trycloudflare
```

- The URL changes every time the tunnel container restarts. On 2026-11-15 it was `https://consistent-hip-floors-compute.trycloudflare.com`.
- `/dev` returns 404 through the tunnel.
- **Sign-in is OFF** (local mode): anyone with the link can use the app and the Gemini quota. Share the link only with testers.

To stop the tunnel, run this on Mac B:
```bash
docker compose stop tunnel
```

## 9. Rollback

Go to the app folder on Mac B:
```bash
cd ~/AQspace
```

Switch to the previous commit you wrote down (replace `<commit>`):
```bash
git checkout <commit>
```

Rebuild on that commit, in the background:
```bash
nohup docker compose up -d --build > deploy.log 2>&1 &
```

Then run the checks from section 6 again. Go back to the branch later with `git checkout preview/latest` (or `main`).

## 10. The urlshortener project

It is stopped, not deleted. Its containers and data are still there.

To bring it back, run this on Mac B inside that project's folder:
```bash
docker compose start
```

Both projects together may not fit in 6 GB. Watch `docker stats` after starting it.

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `ssh aqspace-macb` hangs or fails after a network change | The IP changed. The alias uses `Karans-MacBook-Air.local`, so it should still work on the same network. Check both Macs are on the same Wi-Fi. If mDNS fails, find the IP on Mac B (System Settings > Network) and use `ssh -o HostName=<ip> aqspace-macb`. |
| Host key warning | Compare with the fingerprint in section 1. Do not accept a different one without asking. |
| `docker: command not found` over SSH | Run the `export PATH=...` line from section 2. |
| Build fails with exit 137 | Either a build step container was stopped (section 7) or memory ran out. Check `docker stats`, make sure urlshortener is stopped, and run the build again. |
| App not answering, SSH times out | Mac B went to sleep, most likely on battery. Plug it in, wake it, check `pmset -g custom` (section 4). |
| Nothing runs after a reboot | Check `colima status`; if stopped, run `colima start`. `brew services start colima` makes this automatic. Then `docker compose up -d` in `~/AQspace`. |
| Tunnel URL stopped working | The tunnel container restarted. Get the new URL (section 8). |

## 12. Next: CI/CD (card #161)

The manual deploy above is the fallback. Next step: GitHub Actions running tests on pull requests, building arm64 images, and deploying to Mac B through a self-hosted runner, with secrets from the GitHub `production` environment.
