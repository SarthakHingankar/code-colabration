# Code Collaboration Sandbox

A real-time collaborative code editor with **multi-gateway scaling**, **Redis-backed realtime sync**, **Postgres persistence**, and **sandboxed code execution** via **container-per-execution Docker runs**.

This repo is intentionally designed to be a good **demo** of:
- WebSocket “rooms” (collaboration sessions)
- Cross-instance realtime replication (Redis pub/sub)
- Durable state (Postgres + Prisma)
- Safe-ish execution isolation (Docker sandbox container with no network, read-only FS, resource limits)

---

## Quickstart (run it locally)

### Prerequisites

- **Docker Desktop** (Windows/Mac) or Docker Engine (Linux)
- **Docker Compose v2** (`docker compose`)

Optional (only if you want to run services outside containers):
- Node.js 18+

### Start the stack

From the repository root:

```cmd
docker compose -f backend\docker-compose.yml up -d --build
```

Then open:

- http://localhost:3000

> On Windows, Docker Desktop typically runs with a WSL2 backend. The first run may be slower because images need to build/pull.

### Stop

```cmd
docker compose -f backend\docker-compose.yml down
```

---

## What’s running (services)

All services are defined in `backend/docker-compose.yml`:

- **nginx**: reverse proxy on port **3000** (handles WebSocket upgrade + load balancing)
- **gateway**: HTTP + WebSocket server (UI, rooms, persistence, job enqueue)
- **worker**: background runner (picks execution jobs, runs sandbox containers, streams output)
- **redis**: job queue + pub/sub (collab sync + execution logs)
- **postgres**: persistent storage (Projects, Executions)
- **execution-image**: build-only service that produces the sandbox execution image used by the worker

---

## How to use (end-user workflow)

### 1) Create or join a room

Open the UI.

- **Create room** → generates a Room ID (a Project ID) you can share.
- **Join room** → paste an existing Room ID.

When you join:
- the gateway loads the project from Postgres
- the gateway sends the current code to the browser

### 2) Realtime collaboration

As you type, the browser sends `CODE_UPDATE` messages over WebSocket.

The gateway:
- updates in-memory runtime state for the project
- broadcasts updates to other clients connected to that gateway
- publishes the update to Redis so **other gateway instances** can replicate it

### 3) Run code (sandbox)

Click **Run**.

The gateway will:
- create an `Execution` row in Postgres
- enqueue a job to Redis (includes `executionId`)

The worker will:
- read a job from Redis (BLPOP queue)
- start a **sandboxed Docker container** for the execution
- stream stdout/stderr back via Redis pub/sub

The gateway:
- forwards output to clients in the room
- persists final output/status in Postgres

---

## Architecture (simple overview)

### HTTP/UI
- UI is served from `backend/gateway/public/`.
- REST endpoint `POST /projects` creates a project/room.

### WebSocket protocol (browser ↔ gateway)
The browser sends:
- `JOIN_ROOM` `{ roomId }`
- `CODE_UPDATE` `{ roomId, code }`
- `RUN_CODE` `{ roomId }`

The gateway sends (examples):
- `ROOM_JOINED` and/or `INITIAL_CODE`
- `CODE_UPDATE`
- execution lifecycle events: `EXECUTION_STARTED`, `EXECUTION_OUTPUT`, `EXECUTION_FINISHED`, `EXECUTION_ERROR`

### Cross-gateway collaboration (gateway ↔ Redis ↔ gateway)
- Gateways publish to per-project channels: `collab_<projectId>`
- Gateways subscribe (pattern) `collab_*` and apply updates only for projects they currently serve
- Messages include `origin` (instance id) so a gateway won’t echo its own updates

### Execution queue + logs (gateway ↔ Redis ↔ worker)
- Queue is Redis list-based (worker blocks waiting for jobs)
- Output events are Redis pub/sub and then forwarded to WebSocket clients

---

## Scaling gateways

Gateway containers can be scaled because **Nginx** is the only service binding a fixed host port.

Example:

```cmd
docker compose -f backend\docker-compose.yml up -d --scale gateway=2
```

Nginx (in `backend/nginx/nginx.conf`) handles:
- load balancing to the `gateway` upstream
- WebSocket upgrade headers

---

## Security / sandbox notes

The execution sandbox is designed to be safer than running code directly on the host:
- container-per-execution
- `--network none`
- `--read-only`
- `--cap-drop ALL`
- `--security-opt no-new-privileges`
- memory/cpu/pids limits
- hard timeout kill

**Important:** This is still a demo-style sandbox. For production-grade untrusted code execution you’d typically add stronger isolation (gVisor, Kata, Firecracker, separate hosts, etc.).

---

## Troubleshooting

### WebSocket connects but UI doesn’t leave join screen
- This usually means the join ack/message (`ROOM_JOINED` or `INITIAL_CODE`) didn’t arrive.
- Check gateway logs.

### Execution fails with `/sandbox/main.py` missing (Docker Desktop)
Docker Desktop can make bind mounts unreliable when a containerized worker controls the host daemon.

This project avoids bind mounts for execution and stages code using `docker cp` into a staging container.

### Execution is slow on Windows
Windows + Docker Desktop + WSL2 has extra overhead per container operation.

Mitigations used here:
- warm up the execution image on worker startup
- reuse a small pool of staging containers (config: `STAGER_POOL_SIZE`)

---

## Repo map

- `backend/gateway/` – UI + API + WebSocket gateway + Prisma/Postgres persistence
- `backend/worker/` – background worker and Docker sandbox runner
- `backend/execution-image/` – Docker image used to run code
- `backend/nginx/` – reverse proxy for scaling gateways
- `backend/docker-compose.yml` – orchestration
