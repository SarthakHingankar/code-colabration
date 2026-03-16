// Redis-backed worker loop.
// Blocks on the execution queue, executes code, and publishes logs to per-room channels.

const { connectRedis, waitForJob, publishLog } = require('./queue');
const { runJob } = require('./runner');

async function main() {
    console.log('[worker] starting...');

    // Connect once up-front so we fail fast if Redis isn't reachable.
    const { redis, redisPub } = connectRedis();
    await Promise.all([redis.connect(), redisPub.connect()]);

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
