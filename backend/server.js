const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

const TMP_DIR = path.join(__dirname, 'tmp');

if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR);
}

const rooms = new Map();
const roomCode = new Map();
const roomExecution = new Map();

function handleJoinRoom(socket, roomId) {

    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
    }

    const room = rooms.get(roomId);
    room.add(socket);

    socket.roomId = roomId;

    const users = room.size;
    if (!roomCode.has(roomId)) {
        roomCode.set(roomId, '');
    }
    const latestCode = roomCode.get(roomId);

    socket.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomId,
        users,
        code: latestCode
    }));

    room.forEach(client => {
        if (client !== socket) {
            client.send(JSON.stringify({
                type: 'USER_JOINED',
                users
            }));
        }
    });

    console.log(`User joined room ${roomId}, users: ${users}`);
}

function handleCodeUpdate(socket, roomId, code) {

    const room = rooms.get(roomId);
    if (!room) return;

    roomCode.set(roomId, code);

    room.forEach(client => {
        if (client !== socket) {
            client.send(JSON.stringify({
                type: 'CODE_UPDATE',
                code
            }));
        }
    });
}

function broadcast(room, payload) {
    room.forEach(client => {
        client.send(JSON.stringify(payload));
    });
}

function startExecution(roomId) {

    const room = rooms.get(roomId);
    if (!room) return;

    const latestCode = roomCode.get(roomId) || '';

    // prevent concurrent runs
    if (roomExecution.get(roomId)?.isRunning) {
        return;
    }

    const filePath = path.join(TMP_DIR, `${roomId}.py`);
    fs.writeFileSync(filePath, latestCode);

    const process = spawn('python', ['-u', filePath]);

    roomExecution.set(roomId, {
        process,
        isRunning: true
    });

    broadcast(room, {
        type: 'EXECUTION_STARTED'
    });

    process.stdout.on('data', (data) => {
        broadcast(room, {
            type: 'EXECUTION_OUTPUT',
            line: data.toString()
        });
    });

    process.stderr.on('data', (data) => {
        broadcast(room, {
            type: 'EXECUTION_OUTPUT',
            line: data.toString()
        });
    });

    process.on('close', () => {

        roomExecution.delete(roomId);

        broadcast(room, {
            type: 'EXECUTION_FINISHED'
        });
    });

    // timeout kill (10 sec)
    setTimeout(() => {
        const exec = roomExecution.get(roomId);
        if (exec?.isRunning) {
            exec.process.kill();
            roomExecution.delete(roomId);

            broadcast(room, {
                type: 'EXECUTION_ERROR',
                message: 'Execution timed out'
            });
        }
    }, 10000);
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (socket) => {
    console.log('WebSocket connection established');

    socket.on('close', () => {

        const roomId = socket.roomId;
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        room.delete(socket);

        const users = room.size;

        room.forEach(client => {
            client.send(JSON.stringify({
                type: 'USER_LEFT',
                users
            }));
        });

        if (users === 0) {
            rooms.delete(roomId);
            console.log(`Room ${roomId} deleted`);
        }

        console.log('WebSocket disconnected');
    });

    socket.on('message', (message) => {
        const data = JSON.parse(message.toString());

        if (data.type === 'JOIN_ROOM') {
            handleJoinRoom(socket, data.roomId);
        }

        if (data.type === 'CODE_UPDATE') {
            handleCodeUpdate(socket, data.roomId, data.code);
        }

        if (data.type === 'RUN_CODE') {
            startExecution(data.roomId);
        }
    });
});

server.on('error', (err) => {
    console.error('Server error:', err);
});