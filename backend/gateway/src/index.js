const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const socketLayer = require('./socket');
const queue = require('./queue');
const prisma = require('./prisma');

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

server.on('error', (err) => {
    console.error('Server error:', err);
});

module.exports = { app, server, wss };
