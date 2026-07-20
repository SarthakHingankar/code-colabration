# Distributed Code Execution Platform

Production-inspired backend platform for collaborative code editing and secure execution of untrusted code. The system combines real-time collaboration, asynchronous job processing, and isolated Docker-based execution into a scalable distributed architecture.

---

## Overview

Modern collaborative coding platforms require more than a text editor. They need to synchronize changes between users, execute untrusted code safely, and remain responsive under concurrent workloads.

This project demonstrates a distributed backend architecture that separates collaboration, orchestration, and execution into independent components communicating through Redis. Every code execution runs inside an isolated Docker container while project state and execution history are persisted in PostgreSQL.

---

## Highlights

- Distributed execution pipeline using Redis Pub/Sub and asynchronous workers
- Real-time collaborative editing over WebSockets
- Cross-instance synchronization across multiple gateway servers
- Container-per-execution Docker sandbox for running untrusted code
- Persistent project and execution state using PostgreSQL
- Horizontally scalable gateway architecture behind Nginx
- Secure execution with resource limits, read-only filesystem, and disabled networking

---

## Architecture

```
                        Browser
                           │
                    HTTP / WebSocket
                           │
                     +-------------+
                     |    Nginx    |
                     +-------------+
                      │         │
              +-------+         +-------+
              │                         │
       +-------------+           +-------------+
       |  Gateway 1  |           |  Gateway 2  |
       +-------------+           +-------------+
              │                         │
              └──────── Redis ──────────┘
                    Pub/Sub + Queue
                           │
                     +-------------+
                     |   Worker    |
                     +-------------+
                           │
                 Docker Sandbox Runner
                           │
                     +-------------+
                     | PostgreSQL  |
                     +-------------+
```

---

## Tech Stack

### Backend

- Node.js
- Express
- WebSockets

### Infrastructure

- Docker
- Redis
- Nginx

### Database

- PostgreSQL
- Prisma ORM

---

## System Components

### Gateway

Responsible for:

- HTTP API
- WebSocket connections
- Room management
- Project persistence
- Execution orchestration

---

### Redis

Used for:

- Cross-gateway collaboration synchronization
- Execution job queue
- Streaming execution logs

---

### Worker

Responsible for:

- Processing queued execution jobs
- Launching isolated Docker containers
- Streaming execution output
- Updating execution status

---

### PostgreSQL

Acts as the system's source of truth for:

- Projects
- Source code
- Execution history
- Execution status

---

## Execution Flow

### Real-Time Collaboration

1. User joins a collaboration room.
2. Gateway loads the latest project from PostgreSQL.
3. Code updates are sent through WebSockets.
4. Updates are published through Redis Pub/Sub.
5. Other gateway instances synchronize connected clients.

---

### Code Execution

1. User clicks **Run**.
2. Gateway creates an execution record.
3. Job is pushed into a Redis queue.
4. Worker consumes the job.
5. Worker launches an isolated Docker container.
6. Execution output is streamed through Redis.
7. Gateway forwards logs to connected clients.
8. Results are persisted in PostgreSQL.

---

## Engineering Decisions

### Asynchronous Execution

Execution is handled by background workers instead of the gateway to keep WebSocket connections responsive and prevent long-running code execution from blocking client interactions.

---

### Redis Pub/Sub

Redis Pub/Sub enables collaboration updates to propagate across multiple gateway instances, allowing horizontal scaling without requiring sticky sessions.

---

### Docker Sandboxing

Every execution runs inside an isolated container with:

- No network access
- Read-only filesystem
- Dropped Linux capabilities
- Memory limits
- CPU limits
- PID limits
- Execution timeout

This significantly reduces the risk of untrusted code affecting the host system.

---

### PostgreSQL as Source of Truth

Project state and execution history are persisted in PostgreSQL, ensuring consistency across gateway restarts and worker failures.

---

## Running Locally

### Prerequisites

- Docker
- Docker Compose v2

### Start

```bash
docker compose -f backend/docker-compose.yml up -d --build
```

Application:

```
http://localhost:3000
```

### Stop

```bash
docker compose -f backend/docker-compose.yml down
```

---

## Scaling

The application supports multiple gateway instances.

Example:

```bash
docker compose -f backend/docker-compose.yml up -d --scale gateway=2
```

Nginx load balances incoming HTTP and WebSocket connections while Redis propagates collaboration events between gateway instances.

---

## Security

The execution environment isolates every run using Docker containers configured with:

- Read-only filesystem
- No network access
- Dropped capabilities
- No new privileges
- CPU and memory limits
- Process limits
- Hard execution timeout

> This project demonstrates container-based isolation. Production-grade execution environments would typically employ stronger sandboxing technologies such as Firecracker, gVisor, or Kata Containers.

---

## Project Structure

```
backend/
├── gateway/            # HTTP API + WebSocket gateway
├── worker/             # Background execution workers
├── execution-image/    # Docker execution image
├── nginx/              # Reverse proxy
├── prisma/             # Database schema
└── docker-compose.yml
```

---

## Future Improvements

- Multi-language execution support
- Distributed worker scheduling
- Kubernetes deployment
- Firecracker-based sandboxing
- Autoscaling workers
- Execution caching
- Metrics and monitoring
- Authentication and user management
