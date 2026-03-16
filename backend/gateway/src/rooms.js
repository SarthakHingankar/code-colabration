const { broadcast } = require('./utils');

// rooms and roomCode are the canonical in-memory state
const rooms = new Map();
const roomCode = new Map();

function getRoom(roomId) {
    return rooms.get(roomId);
}

function getCode(roomId) {
    return roomCode.get(roomId) || '';
}

function joinRoom(socket, roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);
    room.add(socket);
    socket.roomId = roomId;

    const users = room.size;
    if (!roomCode.has(roomId)) roomCode.set(roomId, '');
    const latestCode = roomCode.get(roomId);

    // send ROOM_JOINED to joining socket with latest code
    socket.send(JSON.stringify({
        type: 'ROOM_JOINED',
        roomId,
        users,
        code: latestCode
    }));

    // notify others
    room.forEach(client => {
        if (client !== socket) {
            client.send(JSON.stringify({ type: 'USER_JOINED', users }));
        }
    });

    return { room, latestCode };
}

function leaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(socket);
    const users = room.size;

    // notify remaining clients
    room.forEach(client => {
        client.send(JSON.stringify({ type: 'USER_LEFT', users }));
    });

    if (users === 0) {
        rooms.delete(roomId);
        roomCode.delete(roomId);
    }
}

function updateCode(sourceSocket, roomId, code) {
    const room = rooms.get(roomId);
    if (!room) return;
    roomCode.set(roomId, code);
    // broadcast to others
    room.forEach(client => {
        if (client !== sourceSocket) {
            client.send(JSON.stringify({ type: 'CODE_UPDATE', code }));
        }
    });
}

module.exports = {
    joinRoom,
    leaveRoom,
    updateCode,
    getRoom,
    getCode,
};
