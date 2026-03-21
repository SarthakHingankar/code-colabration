// Worker loop: wait for jobs, run them, publish logs.

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
    // Best-effort warmup: ensure image exists.
    try {
        await execDocker(['image', 'inspect', EXECUTION_IMAGE]);
        console.log(`[worker] warmup: execution image present (${EXECUTION_IMAGE})`);
    } catch {
        console.log(`[worker] warmup: pulling execution image (${EXECUTION_IMAGE})...`);
        try {
            await execDocker(['pull', EXECUTION_IMAGE]);
            console.log('[worker] warmup: pull complete');
        } catch (e) {
            console.warn('[worker] warmup: unable to pull image (continuing):', e.message);
        }
    }
}

async function main() {
    console.log('[worker] starting...');

    // Connect up-front.
    const { redis, redisPub } = connectRedis();
    await Promise.all([redis.connect(), redisPub.connect()]);

    await warmupExecutionImage();

    console.log('[worker] connected to redis; waiting for jobs...');
    while (true) {
        const job = await waitForJob();
        if (!job) continue;

        // Sequential execution.
        const roomId = job.roomId;
        try {
            await publishLog(roomId, { type: 'WORKER_JOB_RECEIVED', roomId, ts: Date.now() });
            await runJob(job);
        } catch (err) {
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
