const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');

const socketLayer = require('./socket');
const queue = require('./queue');
const prisma = require('./prisma');
const rooms = require('./rooms');
const { broadcast } = require('./utils');
const { sub } = require('./realtime/collabBus');

const frontendPath = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(frontendPath));

// ---- REST API ----
// Create a new project (the returned id is used as roomId/projectId)
app.post('/projects', async (req, res) => {
    try {
        const { name } = req.body || {};

        const project = await prisma.project.create({
            data: {
                name: name || 'Untitled Project',
                code: ''
            }
        });

        res.json({ projectId: project.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Project creation failed' });
    }
});

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

socketLayer.setupWebSocket(wss);

// If Redis is configured, subscribe once and forward worker execution logs to websocket rooms.
queue.forwardRedisLogsToRooms();

// ---- Cross-gateway collaboration bus ----
// When code is updated on another gateway, replicate into our runtime cache and broadcast
// to our locally-connected users.
if (sub) {
    // Use a single pattern subscription so we don't need to attach new handlers per project.
    // We still only *apply* updates for projects we currently serve (have runtime).
    sub.psubscribe('collab_*').catch(() => { });

    sub.on('pmessage', async (_pattern, channel, message) => {
        let event;
        try {
            event = JSON.parse(message);
        } catch {
            return;
        }

        const instanceId = rooms.getInstanceId();

        if (!event || event.origin === instanceId) return;
        const projectId = event.projectId;
        if (!projectId) return;

        // sanity: ensure message arrived on the expected channel for this project
        const expectedChannel = rooms.getCollabChannel(projectId);
        if (channel !== expectedChannel) return;

        // Only keep a runtime around if we're actively serving this project.
        // If no runtime exists locally, ignore (other gateways will serve their users).
        let runtime = rooms.projectRuntime.get(projectId);
        if (!runtime) return;

        if (event.type === 'PRESENCE') {
            const delta = Number(event.delta || 0);
            if (delta !== 0) {
                rooms.projectPresence.set(projectId, (rooms.projectPresence.get(projectId) || 0) + delta);
                if ((rooms.projectPresence.get(projectId) || 0) <= 0) rooms.projectPresence.delete(projectId);
            }

            const localUsers = rooms.getRoom(projectId);
            if (!localUsers || localUsers.size === 0) return;

            broadcast(localUsers, {
                type: 'PRESENCE',
                usersLocal: localUsers.size,
                usersApproxGlobal: rooms.projectPresence.get(projectId) || localUsers.size
            });
            return;
        }

        if (event.type !== 'CODE_UPDATE') return;

        const applied = rooms.applyRemoteCode(projectId, event.code || '', event.ts);
        if (!applied) return;

        const localUsers = rooms.getRoom(projectId);
        if (!localUsers || localUsers.size === 0) return;

        broadcast(localUsers, { type: 'CODE_UPDATE', code: rooms.getCode(projectId) });
    });
}

// ---- Stage-2.5 hygiene: periodic cleanup + memory stats ----
const CLEANUP_INTERVAL_MS = 60 * 1000;
const EVICT_AFTER_MS = Number(process.env.RUNTIME_EVICT_AFTER_MS || 2 * 60 * 1000);
setInterval(() => {
    const now = Date.now();
    let evicted = 0;

    for (const [projectId, runtime] of rooms.projectRuntime.entries()) {
        if (!runtime) continue;
        if (runtime.users && runtime.users.size > 0) continue;
        const last = Number(runtime.lastActivityAt || 0);
        if (last && now - last >= EVICT_AFTER_MS) {
            // If there's a pending eviction timer, it should handle it, but this is a safety net.
            if (runtime.saveTimer) clearTimeout(runtime.saveTimer);
            if (runtime.evictionTimer) clearTimeout(runtime.evictionTimer);
            rooms.maybeUnsubscribe(projectId);
            rooms.projectRuntime.delete(projectId);
            rooms.projectPresence.delete(projectId);
            evicted++;
        }
    }

    const m = process.memoryUsage();
    // Keep logs short; this is mainly to simulate production observability.
    console.log(
        `[cleanup] runtimes=${rooms.projectRuntime.size} evicted=${evicted} heapUsedMB=${(m.heapUsed / 1024 / 1024).toFixed(1)} rssMB=${(m.rss / 1024 / 1024).toFixed(1)}`
    );
}, CLEANUP_INTERVAL_MS).unref?.();

server.on('error', (err) => {
    console.error('Server error:', err);
});

module.exports = { app, server, wss };
