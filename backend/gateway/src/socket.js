const rooms = require('./rooms');
const execution = require('./execution');

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
            }

            if (data.type === 'CODE_UPDATE') {
                rooms.updateCode(socket, data.roomId, data.code);
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
