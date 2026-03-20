const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { publishLog } = require('./queue');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const DEFAULT_TIMEOUT_MS = Number(process.env.EXECUTION_TIMEOUT_MS || 10_000);

function ensureTmpDir() {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function jobToFilePath(roomId) {
    // keep stable file name per room; worker doesn't know about room maps, only roomId
    return path.join(TMP_DIR, `${roomId}.py`);
}

/**
 * runJob(job)
 * job: { roomId, code }
 * Streams stdout/stderr as EXECUTION_OUTPUT and publishes EXECUTION_FINISHED / EXECUTION_ERROR.
 */
async function runJob(job) {
    const roomId = job?.roomId;
    if (!roomId) throw new Error('Job missing roomId');
    const executionId = job?.executionId;

    ensureTmpDir();
    const filePath = jobToFilePath(roomId);
    fs.writeFileSync(filePath, job.code || '', 'utf8');

    // Notify start
    await publishLog(roomId, { type: 'EXECUTION_STARTED', executionId });

    const proc = spawn('python3', ['-u', filePath]);

    let done = false;
    let timer = null;

    async function finishOnce(kind, payload) {
        if (done) return;
        done = true;

        if (timer) {
            clearTimeout(timer);
            timer = null;
        }

        if (kind === 'finished') {
            await publishLog(roomId, { type: 'EXECUTION_FINISHED', executionId, ...payload });
            return;
        }

        await publishLog(roomId, { type: 'EXECUTION_ERROR', executionId, message: payload?.message || String(payload) });
    }

    proc.stdout.on('data', (data) => {
        // Fire-and-forget; we don't await inside stream handlers.
        publishLog(roomId, { type: 'EXECUTION_OUTPUT', executionId, stream: 'stdout', line: data.toString() }).catch(() => { });
    });

    proc.stderr.on('data', (data) => {
        publishLog(roomId, { type: 'EXECUTION_OUTPUT', executionId, stream: 'stderr', line: data.toString() }).catch(() => { });
    });

    proc.on('error', (err) => {
        finishOnce('error', { message: err?.message || String(err) }).catch(() => { });
    });

    proc.on('close', (code) => {
        finishOnce('finished', { code }).catch(() => { });
    });

    timer = setTimeout(() => {
        try { proc.kill(); } catch (e) { }
        finishOnce('error', { message: 'Execution timed out' }).catch(() => { });
    }, DEFAULT_TIMEOUT_MS);

    return {
        roomId,
        filePath,
        kill() {
            try { proc.kill(); } catch (e) { }
            return finishOnce('error', { message: 'Execution killed' });
        }
    };
}

module.exports = {
    runJob,
    TMP_DIR,
    DEFAULT_TIMEOUT_MS
};
