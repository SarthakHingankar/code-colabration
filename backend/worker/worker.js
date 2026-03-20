// Redis-backed worker loop.
// Blocks on the execution queue, executes code, and publishes logs to per-room channels.

const { connectRedis, waitForJob, publishLog } = require('./queue');
const { runJob } = require('./runner');

const { spawn } = require('child_process');

const EXECUTION_IMAGE = process.env.EXECUTION_IMAGE || 'execution-image:latest';
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';

function execDocker(args) {
    return new Promise((resolve, reject) => {
        const p = spawn(DOCKER_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => { out += d.toString(); });
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code === 0) return resolve({ out, err });
            const e = new Error(`docker ${args[0]} failed (code ${code}): ${err || out}`);
            e.code = code;
            reject(e);
        });
    });
}

async function warmupExecutionImage() {
    // Best-effort warmup: ensures the image is present so the first run doesn't pay pull/load costs.
    try {
        await execDocker(['image', 'inspect', EXECUTION_IMAGE]);
        console.log(`[worker] warmup: execution image present (${EXECUTION_IMAGE})`);
    } catch {
        console.log(`[worker] warmup: pulling execution image (${EXECUTION_IMAGE})...`);
        try {
            await execDocker(['pull', EXECUTION_IMAGE]);
            console.log('[worker] warmup: pull complete');
        } catch (e) {
            // Don't fail startup if pull isn't possible (e.g., image built locally by compose).
            console.warn('[worker] warmup: unable to pull image (continuing):', e.message);
        }
    }
}

async function main() {
    console.log('[worker] starting...');

    // Connect once up-front so we fail fast if Redis isn't reachable.
    const { redis, redisPub } = connectRedis();
    await Promise.all([redis.connect(), redisPub.connect()]);

    await warmupExecutionImage();

    console.log('[worker] connected to redis; waiting for jobs...');
    while (true) {
        const job = await waitForJob();
        if (!job) continue;

        // Sequential execution only: we await the runner before waiting for the next job.
        const roomId = job.roomId;
        try {
            await publishLog(roomId, { type: 'WORKER_JOB_RECEIVED', roomId, ts: Date.now() });
            await runJob(job);
        } catch (err) {
            // Best-effort error publish.
            try {
                await publishLog(roomId || 'unknown', { type: 'EXECUTION_ERROR', message: err?.message || String(err) });
            } catch (e) {
                console.error('[worker] failed to publish error:', e);
            }
        }
    }
}

main().catch((err) => {
    console.error('[worker] fatal error:', err);
    process.exitCode = 1;
});
