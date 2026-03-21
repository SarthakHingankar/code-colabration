const queue = require('./queue');
const { broadcast } = require('./utils');
const roomsModule = require('./rooms');
const prisma = require('./prisma');
const { v4: uuid } = require('uuid');

// Inject updater into queue (avoid circular deps).
queue.setExecutionStateUpdater(updateExecutionStateFromWorker);

// Gateway-side execution state.
const STATES = {
    IDLE: 'IDLE',
    QUEUED: 'QUEUED',
    RUNNING: 'RUNNING',
    FINISHED: 'FINISHED',
    ERROR: 'ERROR'
};

// roomId -> { state, jobId, updatedAt }
const roomExecution = new Map();

function getExecutionState(roomId) {
    return roomExecution.get(roomId) || { state: STATES.IDLE };
}

function setExecutionState(roomId, next) {
    if (!next || next.state === STATES.IDLE) {
        roomExecution.delete(roomId);
        return;
    }
    roomExecution.set(roomId, { ...next, updatedAt: Date.now() });
}

// Called when worker log events arrive via Redis.
function updateExecutionStateFromWorker(roomId, payload) {
    if (!roomId || !payload || typeof payload !== 'object') return;
    const type = payload.type;

    const current = getExecutionState(roomId);

    if (type === 'EXECUTION_STARTED') {
        setExecutionState(roomId, { state: STATES.RUNNING, jobId: current.jobId || payload.jobId });
        return;
    }

    if (type === 'EXECUTION_FINISHED') {
        setExecutionState(roomId, { state: STATES.FINISHED, jobId: current.jobId || payload.jobId });
        setExecutionState(roomId, { state: STATES.IDLE });
        return;
    }

    if (type === 'EXECUTION_ERROR') {
        setExecutionState(roomId, { state: STATES.ERROR, jobId: current.jobId || payload.jobId });
        setExecutionState(roomId, { state: STATES.IDLE });
        return;
    }
}

async function startExecution(roomId) {
    const room = roomsModule.getRoom(roomId);
    if (!room) return;

    // Prevent concurrent runs.
    const current = getExecutionState(roomId);
    if (current.state === STATES.QUEUED || current.state === STATES.RUNNING) return;

    const latestCode = roomsModule.getCode(roomId) || '';

    // Create an Execution row for tracking.
    let executionRow;
    try {
        executionRow = await prisma.execution.create({
            data: {
                projectId: roomId,
                status: 'QUEUED',
                output: ''
            }
        });
    } catch (err) {
        broadcast(room, { type: 'EXECUTION_ERROR', message: err?.message || String(err) });
        return;
    }

    const executionId = executionRow.id;

    const job = {
        jobId: uuid(),
        roomId,
        projectId: roomId,
        executionId,
        code: latestCode,
        createdAt: Date.now()
    };

    // Mark queued before enqueue.
    const execState = { state: STATES.QUEUED, jobId: job.jobId };
    setExecutionState(roomId, execState);

    broadcast(room, { type: 'EXECUTION_QUEUED', jobId: job.jobId, executionId });

    try {
        await queue.pushJob(job);
    } catch (err) {
        setExecutionState(roomId, { state: STATES.IDLE });
        // Best-effort persist failure.
        try {
            await prisma.execution.update({
                where: { id: executionId },
                data: { status: 'FAILED', output: err?.message || String(err) }
            });
        } catch (e) {
            // ignore
        }
        broadcast(room, { type: 'EXECUTION_ERROR', message: err?.message || String(err) });
    }

    return execState;
}

module.exports = {
    startExecution,
    updateExecutionStateFromWorker,
    getExecutionState,
    STATES,
    // Compatibility view used by socket.js guard
    _roomExecution: {
        get(roomId) {
            const s = getExecutionState(roomId);
            return {
                state: s.state,
                jobId: s.jobId,
                isRunning: s.state === STATES.QUEUED || s.state === STATES.RUNNING
            };
        }
    }
};
