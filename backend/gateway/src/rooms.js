const prisma = require('./prisma');

// Runtime cache per projectId:
// {
//    code: string,
//    users: Set<WebSocket>,
//    saveTimer: NodeJS.Timeout | null
// }
const projectRuntime = new Map();

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
            saveTimer: null
        };

        projectRuntime.set(projectId, runtime);
    }

    runtime.users.add(ws);
    ws.roomId = projectId;

    // Compatibility/UI ack: lets client switch screens and show user count.
    ws.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomId: projectId,
        users: runtime.users.size,
        code: runtime.code
    }));

    // Let client hydrate editor
    ws.send(JSON.stringify({
        type: 'INITIAL_CODE',
        code: runtime.code
    }));

    // Notify others in memory
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

    runtime.users.forEach((client) => {
        client.send(JSON.stringify({ type: 'USER_LEFT', users }));
    });

    if (users === 0) {
        if (runtime.saveTimer) clearTimeout(runtime.saveTimer);
        projectRuntime.delete(projectId);
    }
}

function updateCode(sourceWs, projectId, newCode) {
    const runtime = projectRuntime.get(projectId);
    if (!runtime) return;
    runtime.code = newCode;

    // broadcast to others (realtime stays memory-driven)
    runtime.users.forEach((client) => {
        if (client !== sourceWs) {
            client.send(JSON.stringify({ type: 'CODE_UPDATE', code: newCode }));
        }
    });

    // debounce DB write
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

module.exports = {
    joinRoom,
    leaveRoom,
    updateCode,
    getRoom,
    getCode,
    projectRuntime
};
