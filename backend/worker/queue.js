const Redis = require('ioredis');

// Default queue/channel naming (env override).
const EXECUTION_JOBS_LIST = process.env.EXECUTION_JOBS_LIST || 'execution_jobs';
const LOG_CHANNEL_PREFIX = process.env.EXECUTION_LOGS_PREFIX || 'execution_logs_';

let redis = null;
let redisPub = null;

function getRedisUrl() {
    return process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || 'redis://127.0.0.1:6379';
}

// Connect (idempotent). Uses one client for BLPOP and one for publish.
function connectRedis() {
    if (redis && redisPub) return { redis, redisPub };

    const url = getRedisUrl();
    redis = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: null
    });
    redisPub = new Redis(url, {
        lazyConnect: true
    });

    const onError = (err) => console.error('[worker][redis] error:', err?.message || err);
    redis.on('error', onError);
    redisPub.on('error', onError);

    return { redis, redisPub };
}

// Blocking pop of a job from the execution list.
async function waitForJob() {
    const { redis } = connectRedis();
    if (redis.status === 'wait' || redis.status === 'end') {
        // no-op, ioredis may still connect fine with connect()
    }
    if (redis.status !== 'ready') await redis.connect();

    const res = await redis.blpop(EXECUTION_JOBS_LIST, 0);
    // ioredis returns [listName, value]
    const value = Array.isArray(res) ? res[1] : null;
    if (typeof value !== 'string') return null;

    try {
        return JSON.parse(value);
    } catch { return { raw: value }; }
}

// Publish a payload to execution_logs_<roomId>.
async function publishLog(roomId, payload) {
    const { redisPub } = connectRedis();
    if (redisPub.status !== 'ready') await redisPub.connect();

    const channel = `${LOG_CHANNEL_PREFIX}${roomId}`;
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return redisPub.publish(channel, message);
}

async function disconnectRedis() {
    const clients = [redis, redisPub].filter(Boolean);
    await Promise.allSettled(clients.map((c) => c.quit()));
    redis = null;
    redisPub = null;
}

module.exports = {
    connectRedis,
    disconnectRedis,
    waitForJob,
    publishLog,
    EXECUTION_JOBS_LIST,
    LOG_CHANNEL_PREFIX
};
