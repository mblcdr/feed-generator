# Running with Docker

[← Back to the README](../README.md)

```bash
docker compose up -d --build      # first build takes a few minutes; then open http://localhost:5959 (change with HOST_PORT)
docker compose logs -f            # follow the log
docker compose down               # stop (data is kept in the `feed-data` volume)
```

* **Versions / pinning**: pushing a git tag such as `v1.2.0` publishes `ghcr.io/<owner>/<repo>` with the tags `1.2.0` (immutable), `1.2` (latest patch of that minor), `1` (latest of that major, not for `0.x`) and `sha-<commit>`;
  `latest` follows the `main` branch. To lock a version set `FEED_IMAGE=ghcr.io/<owner>/<repo>:1.2.0` (or write it in `.env`) and upgrade by changing the tag; the data volume is kept. Release with `git tag v1.2.0 && git push --tags`
  (keep `version` in `package.json` in step).
* **Website**: `site/` is a static GitHub Pages site (highlights and setup guide) deployed by `.github/workflows/pages.yml`; enable it once under Settings → Pages → Source: *GitHub Actions*.
* **Prebuilt image / Portainer**: `.github/workflows/docker.yml` builds an Intel + ARM image on every push to `main` (and `v*` tags) and pushes it to `ghcr.io/<owner>/<repo>`.
  `compose.ghcr.yaml` is the same stack but pulls that image: replace `OWNER/REPO` in it (lowercase) or set `FEED_IMAGE`. In Portainer use *Stacks → Add stack → Repository* with compose path
  `compose.ghcr.yaml` and set `HOST_PORT` etc. under *Environment variables*. Make the package public (GitHub → Packages → Package settings), or add ghcr.io as a registry in Portainer with a token.
* The image is `node:26-alpine` + Alpine's `chromium` (works on Intel and Apple Silicon; Puppeteer's own Chrome download isn't available for Linux arm64).
  It runs as the unprivileged `node` user with `CHROME_NO_SANDBOX=1` (Chromium's sandbox can't run inside a container; the container is the boundary).
* Feeds, `settings.json` and the image cache live in the `feed-data` volume mounted at `/data`. Back up: `docker run --rm -v feed-generator_feed-data:/data -v "$PWD":/backup alpine tar czf /backup/feed-data.tgz -C /data .`
  (the volume name is prefixed with the compose project name, check `docker volume ls`). To use a folder instead, replace the volume with `./data:/data` and make it writable for uid 1000.
* The port is published on all interfaces by default (`BIND_ADDR=0.0.0.0`) and `ALLOWED_HOSTS` defaults to `lan`, so the app and other instances (sync) can reach it from the local network
  (private IPv4 addresses, `nas:3000`, `*.local`, `*.lan`). The app has **no login**: use a trusted network and don't forward the port. Settings go in a `.env` file next to `compose.yaml` or the shell:
  `HOST_PORT`, `BIND_ADDR` (`127.0.0.1` = this computer only), `FEED_LANG` (e.g. `nl-NL`), `TZ`, `ALLOWED_HOSTS` (add names with `lan,my.domain:3000`).
* `.dockerignore` keeps `node_modules`, `data` and tests out of the build context. Running without Docker (`npm start`) and with Docker use separate data folders.

