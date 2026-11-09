# Running Eagle Eye in GitHub Codespaces

Run the full stack in a cloud machine from VS Code on your PC, with no Docker Desktop or WSL locally.

## How it works

- **Dev container.** `.devcontainer/devcontainer.json` describes a workspace: a base Linux image plus features (Docker engine, Node.js, Terraform) and a setup command (installs uv). Anyone who opens the repo in a dev container gets the same tools.
- **Codespace.** GitHub builds that dev container on a virtual machine in its cloud and keeps it for you: your files, terminal history and running containers persist until you delete it. You pay in core-hours; a stopped codespace only uses storage.
- **Docker in Docker.** The codespace runs its own Docker engine, so `docker compose` starts the same containers as on a laptop: Postgres, Keycloak, Azurite, Mailpit, GreenMail, the backend and the web app.
- **Port forwarding.** VS Code desktop tunnels each container port to the same port on your PC. The app expects `localhost` addresses (the sign-in redirect goes to `localhost:8180`, evidence uploads to `localhost:10000`), so it works unchanged. The browser-only codespace URLs (`*.app.github.dev`) do not, because those redirects would point at the wrong host; use VS Code desktop.

## Cost

Personal GitHub accounts include 120 core-hours and 15 GB of codespace storage a month. This repo asks for at least 8 GB of memory, which is the 2-core machine: about 60 hours of running time a month. Codespaces stop after 30 minutes idle by default. Set a spending limit of USD 0 (GitHub Settings, Billing and plans) to make sure nothing is charged.

## Set up (once)

1. In VS Code, install the **GitHub Codespaces** extension and sign in to GitHub when asked.
2. Free the ports on your PC: nothing else should be listening on 8080, 8000, 8180, 10000 or 8025 (Docker Desktop stopped is fine).

## Start

1. Command Palette (Ctrl+Shift+P), **Codespaces: Create New Codespace**, pick `ejub-has/eagleeyesoc`, branch `main`, machine **2 cores, 8 GB**. The first build takes a few minutes; VS Code reopens connected to it.
2. In the VS Code terminal (it runs in the codespace):

   ```sh
   docker compose -f deploy/compose.yaml up --build -d --wait
   ```

   The first build takes 5-10 minutes; later starts take about a minute.
3. Open the **Ports** panel (next to Terminal). Each port shows a local address; they should be `localhost:<same port>`. If one shows a different number, stop whatever uses that port on your PC and forward it again.
4. Browse to <http://localhost:8080> and sign in as `admin` / `admin`. Keycloak asks you to enroll an authenticator app on the first sign-in.

## Load sample alerts

1. In the app, Settings, API tokens: create a token with the `alerts:write` scope and copy it.
2. In the terminal: `deploy/load-samples.sh <token>`.
3. Cases shows the CrowdStrike detection with its ATT&CK tactic and technique; Triage shows the Elastic alert.

## Stop, resume, delete

- Stop the containers: `docker compose -f deploy/compose.yaml down` (add `-v` to wipe the data).
- Stop the codespace (saves core-hours): Command Palette, **Codespaces: Stop Current Codespace**. Resume with **Codespaces: Connect to Codespace**; run the `up` command again.
- Delete it when finished: github.com/codespaces, the codespace's menu, Delete. Unpushed work in it is lost.

## Working on code

The codespace is a full clone. Create a branch, commit and push as on your PC; Git uses your GitHub sign-in. Rebuild one service after a change with `docker compose -f deploy/compose.yaml up --build -d backend` (or `frontend`).
