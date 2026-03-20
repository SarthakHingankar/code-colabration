const rooms = require('./rooms');
const execution = require('./execution');
const { pub } = require('./realtime/collabBus');

function setupWebSocket(wss) {
    wss.on('connection', (socket) => {
        console.log('WebSocket connection established');

        socket.on('close', () => {
            // delegate leave handling
            rooms.leaveRoom(socket);
            console.log('WebSocket disconnected');
        });

        socket.on('message', async (message) => {
            let data;
            try {
                data = JSON.parse(message.toString());
            } catch (e) {
                return;
            }

            if (data.type === 'JOIN_ROOM') {
                await rooms.joinRoom(socket, data.roomId);
                // broadcast presence to other gateways (best effort)
                rooms.publishPresence(data.roomId, +1);
            }

            if (data.type === 'CODE_UPDATE') {
                const projectId = data.roomId;
                rooms.updateCode(socket, projectId, data.code);

                // Cross-gateway sync: publish to Redis so other gateways can broadcast locally.
                // Best-effort: local updates must still work if Redis is down.
                if (pub) {
                    pub.publish(rooms.getCollabChannel(projectId), JSON.stringify({
                        type: 'CODE_UPDATE',
                        projectId,
                        code: data.code,
                        ts: Date.now(),
                        origin: rooms.getInstanceId()
                    })).catch(() => { });
                }
            }

            if (data.type === 'RUN_CODE') {
                // prevent concurrent runs at the socket layer as an extra guard
                const roomId = data.roomId;
                const execMap = execution._roomExecution;
                if (execMap && execMap.get(roomId)?.isRunning) {
                    socket.send(JSON.stringify({ type: 'EXECUTION_ALREADY_RUNNING', roomId }));
                    return;
                }
                execution.startExecution(roomId);
            }
        });
    });
}

module.exports = { setupWebSocket };
