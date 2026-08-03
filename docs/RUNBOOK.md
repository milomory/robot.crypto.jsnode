# Runbook

## Local Development

Start an SSH tunnel to the server Postgres:

```bash
ssh -N -L 3580:127.0.0.1:3580 igorjan94.ru
```

Create a local `.env` from `.env.example` only when you need local API access to the server database. The real `DB_PASSWORD` lives in `/home/mil/robot.crypto.jsnode/.env.app` on the server; do not print it into chat or commit it.

## Checks

```bash
npm run db:status
npm run db:migrate
npm test
npm run lint
```

## Dev Servers

```bash
npm run dev:api
npm run dev:ui
```

API: `http://127.0.0.1:3000`

UI: `http://127.0.0.1:5173`

## Server Database

Server path:

```bash
/home/mil/robot.crypto.jsnode
```

Postgres container:

```bash
pg-crypto-robot
```

Status:

```bash
ssh igorjan94.ru 'cd /home/mil/robot.crypto.jsnode && docker-compose ps'
```

## Server Dashboard

The API/dashboard container is exposed with Basic Auth:

```text
http://crypto.igorjan94.ru:5758
```

Health check:

```bash
ssh igorjan94.ru 'curl -sS http://127.0.0.1:5758/api/status'
```

Credentials live in `/home/mil/robot.crypto.jsnode/.env.app` as `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`. Do not print them into chat or commit them.

Deploy current local files without secrets:

```bash
git ls-files --cached --others --exclude-standard > /tmp/crypto-robot-files.txt
COPYFILE_DISABLE=1 tar --no-xattrs -cf /tmp/crypto-robot-deploy.tar -T /tmp/crypto-robot-files.txt
ssh igorjan94.ru 'cat > /tmp/crypto-robot-deploy.tar' < /tmp/crypto-robot-deploy.tar
ssh igorjan94.ru 'cd /home/mil/robot.crypto.jsnode && docker-compose stop api && docker run --rm -v /home/mil/robot.crypto.jsnode/app:/work node:22-slim sh -lc "rm -rf /work/* /work/.[!.]* /work/..?*" && tar -xf /tmp/crypto-robot-deploy.tar -C app && find app -name "._*" -delete && docker-compose up -d --force-recreate api'
```

## HTTPS Handoff

The server already has system nginx on ports `80` and `443`, so do not start a second Caddy/nginx listener on those ports. The prepared HTTPS target is:

```text
https://igorjan94.ru/crypto/
```

The app supports this path through build-time variables:

```bash
VITE_BASE_PATH=/crypto/
VITE_API_BASE=/crypto-api
```

Activation requires root access to nginx. Insert the contents of `deploy/nginx-igorjan94-crypto-location.conf` into the existing HTTPS `server` block for `igorjan94.ru`, then validate and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

After nginx is active, switch the app container to the HTTPS compose file so port `5758` is bound only to localhost:

```bash
cd /home/mil/robot.crypto.jsnode
cp app/deploy/docker-compose.https.server.yml docker-compose.yml
docker-compose up -d --force-recreate api
```

Verification:

```bash
curl -I https://igorjan94.ru/crypto/
curl -sS -u "$DASHBOARD_USERNAME:$DASHBOARD_PASSWORD" https://igorjan94.ru/crypto-api/status
curl -sS http://127.0.0.1:5758/health
```

The direct external URL `http://crypto.igorjan94.ru:5758` should stop working after the localhost-only bind is activated.

## Exchange Keys

When exchange keys are introduced:

- start with read-only keys;
- disable withdrawal permissions;
- keep trading permission disabled until an explicit live-trading phase;
- write keys only to server-side env/secret files with `600` permissions;
- never paste secrets into chat or commit them to git.
