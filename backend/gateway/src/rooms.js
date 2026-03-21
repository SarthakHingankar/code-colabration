const prisma = require('./prisma');
const os = require('os');
const { sub, pub } = require('./realtime/collabBus');

// Runtime cache: projectId -> { code, users, timers, ts, subscribed }.
const projectRuntime = new Map();

// Approximate cross-gateway presence (UX only).
const projectPresence = new Map();

const EVICT_AFTER_MS = Number(process.env.RUNTIME_EVICT_AFTER_MS || 2 * 60 * 1000);

function getInstanceId() {
    return process.env.INSTANCE_ID || os.hostname();
}

function getCollabChannel(projectId) {
    return `collab_${projectId}`;
}

async function ensureSubscribed(projectId) {
    if (!sub) return;
    const runtime = projectRuntime.get(projectId);
    if (!runtime || runtime.subscribed) return;
    try {
        await sub.subscribe(getCollabChannel(projectId));
        runtime.subscribed = true;
    } catch {
        // best effort only
    }
}

async function maybeUnsubscribe(projectId) {
    if (!sub) return;
    const runtime = projectRuntime.get(projectId);
    if (!runtime || !runtime.subscribed) return;
    try {
        await sub.unsubscribe(getCollabChannel(projectId));
        runtime.subscribed = false;
    } catch {
        // best effort only
    }
}

function getRoom(projectId) {
    return projectRuntime.get(projectId)?.users;
}

function getCode(projectId) {
    return projectRuntime.get(projectId)?.code || '';
}

async function joinRoom(ws, projectId) {
    if (!projectId) return;

    let runtime = projectRuntime.get(projectId);

    // First user: load from DB
    if (!runtime) {
        const project = await prisma.project.findUnique({
            where: { id: projectId }
        });

        if (!project) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Project not found' }));
            return;
        }

        runtime = {
            code: project.code || '',
            users: new Set(),
            saveTimer: null,
            lastTs: 0,
            evictionTimer: null,
            lastActivityAt: Date.now(),
            subscribed: false
        };

        projectRuntime.set(projectId, runtime);
    }

    // Cancel pending eviction.
    if (runtime.evictionTimer) {
        clearTimeout(runtime.evictionTimer);
        runtime.evictionTimer = null;
    }

    // Subscribe to project channel.
    await ensureSubscribed(projectId);

    runtime.users.add(ws);
    ws.roomId = projectId;
    runtime.lastActivityAt = Date.now();

    projectPresence.set(projectId, (projectPresence.get(projectId) || 0) + 1);

    // UI ack.
    ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomId: projectId,
        users: runtime.users.size,
        code: runtime.code
    }));

    // Hydrate editor.
    ws.send(JSON.stringify({
        type: 'INITIAL_CODE',
        code: runtime.code
    }));

    // Notify others.
    const users = runtime.users.size;
    runtime.users.forEach((client) => {
        if (client !== ws) client.send(JSON.stringify({ type: 'USER_JOINED', users }));
    });

    return runtime;
}

function leaveRoom(ws) {
    const projectId = ws.roomId;
    if (!projectId) return;
    const runtime = projectRuntime.get(projectId);
    if (!runtime) return;

    runtime.users.delete(ws);
    const users = runtime.users.size;

    runtime.lastActivityAt = Date.now();

    projectPresence.set(projectId, (projectPresence.get(projectId) || 0) - 1);
    if ((projectPresence.get(projectId) || 0) <= 0) projectPresence.delete(projectId);

    runtime.users.forEach((client) => {
        client.send(JSON.stringify({ type: 'USER_LEFT', users }));
    });

    if (users === 0) {
        // Start idle eviction.
        if (runtime.evictionTimer) clearTimeout(runtime.evictionTimer);
        runtime.evictionTimer = setTimeout(async () => {
            const r = projectRuntime.get(projectId);
            if (!r) return;
            if (r.users.size > 0) return;

            if (r.saveTimer) clearTimeout(r.saveTimer);
            if (r.evictionTimer) clearTimeout(r.evictionTimer);

            await maybeUnsubscribe(projectId);
            projectRuntime.delete(projectId);
        }, EVICT_AFTER_MS);

        // Unsubscribe early; resubscribe on next join.
        maybeUnsubscribe(projectId);
    }
}

function updateCode(sourceWs, projectId, newCode) {
    const runtime = projectRuntime.get(projectId);
    if (!runtime) return;
    runtime.code = newCode;
    runtime.lastTs = Date.now();
    runtime.lastActivityAt = Date.now();

    // Broadcast to others.
    runtime.users.forEach((client) => {
        if (client !== sourceWs) {
            client.send(JSON.stringify({ type: 'CODE_UPDATE', code: newCode }));
        }
    });

    // Debounced DB write.
    if (runtime.saveTimer) clearTimeout(runtime.saveTimer);
    runtime.saveTimer = setTimeout(async () => {
        try {
            await prisma.project.update({
                where: { id: projectId },
                data: { code: runtime.code }
            });
        } catch (e) {
            // don't crash on DB hiccups
        }
    }, 1500);
}

function applyRemoteCode(projectId, newCode, ts) {
    const runtime = projectRuntime.get(projectId);
    if (!runtime) return false;
    const incomingTs = Number(ts || 0);
    if (incomingTs < (runtime.lastTs || 0)) return false;
    runtime.code = newCode;
    runtime.lastTs = incomingTs;
    runtime.lastActivityAt = Date.now();
    return true;
}

function publishPresence(projectId, delta) {
    if (!pub) return;
    pub.publish(getCollabChannel(projectId), JSON.stringify({
        type: 'PRESENCE',
        projectId,
        delta,
        origin: getInstanceId(),
        ts: Date.now()
    })).catch(() => { });
}

module.exports = {
    joinRoom,
    leaveRoom,
    updateCode,
    applyRemoteCode,
    getCollabChannel,
    getInstanceId,
    ensureSubscribed,
    maybeUnsubscribe,
    publishPresence,
    getRoom,
    getCode,
    projectRuntime,
    projectPresence
};
