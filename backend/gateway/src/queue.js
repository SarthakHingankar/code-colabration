const Redis = require('ioredis');

const rooms = require('./rooms');
const { broadcast, logger } = require('./utils');

// execution state updater is injected at runtime to avoid circular deps
let executionStateUpdater = null;

function setExecutionStateUpdater(fn) {
    executionStateUpdater = typeof fn === 'function' ? fn : null;
}

// ---- Redis producer/subscriber (optional) ----

const EXECUTION_JOBS_LIST = process.env.EXECUTION_JOBS_LIST || 'execution_jobs';
const LOG_CHANNEL_PREFIX = process.env.EXECUTION_LOGS_PREFIX || 'execution_logs_';

let redisPush = null;
let redisSub = null;
let redisReady = false;
let subscribed = false;

function getRedisUrl() {
    return process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || "redis://localhost:6379";
}

function initRedis() {
    if (redisPush && redisSub) return { redisPush, redisSub };
    const url = getRedisUrl();
    if (!url) return null;

    redisPush = new Redis(url, { lazyConnect: true });
    redisSub = new Redis(url, { lazyConnect: true });

    const onError = (err) => {
        redisReady = false;
        logger('[gateway][redis] error:', err?.message || err);
    };
    redisPush.on('error', onError);
    redisSub.on('error', onError);
    return { redisPush, redisSub };
}

async function ensureRedisConnected() {
    const clients = initRedis();
    if (!clients) return false;
    try {
        if (redisPush.status !== 'ready') await redisPush.connect();
        if (redisSub.status !== 'ready') await redisSub.connect();
        redisReady = true;
        return true;
    } catch (e) {
        redisReady = false;
        logger('[gateway][redis] connect failed');
        return false;
    }
}

/**
 * subscribeToExecutionLogs(onMessage)
 * Subscribes once to all execution log channels (execution_logs_*).
 * Calls onMessage({ roomId, payload, channel }) for each received message.
 */
function subscribeToExecutionLogs(onMessage) {
    if (subscribed) return;
    subscribed = true;

    ensureRedisConnected().then((ok) => {
        if (!ok) return;
        const pattern = `${LOG_CHANNEL_PREFIX}*`;
        redisSub.psubscribe(pattern).catch((e) => {
            logger('[gateway][redis] psubscribe failed:', e?.message || e);
        });

        redisSub.on('pmessage', (_pattern, channel, message) => {
            // channel looks like execution_logs_<roomId>
            const roomId = channel.startsWith(LOG_CHANNEL_PREFIX) ? channel.slice(LOG_CHANNEL_PREFIX.length) : null;
            let payload = message;
            try { payload = JSON.parse(message); } catch { /* keep raw */ }
            try {
                onMessage && onMessage({ roomId, channel, payload });
            } catch (e) {
                // don't crash subscriber loop
            }
        });
    });
}

/**
 * pushJob(job)
 * Redis-only: gateway is a realtime router. Execution happens in worker.
 */
function pushJob(job) {
    return (async () => {
        const ok = await ensureRedisConnected();
        if (!ok) throw new Error('Redis not available (set REDIS_URL)');
        await redisPush.lpush(EXECUTION_JOBS_LIST, JSON.stringify(job));
        return { queued: true, jobId: job.jobId };
    })();
}

// Convenience: forward Redis execution logs to websocket rooms.
// Call once during gateway startup.
function forwardRedisLogsToRooms() {
    subscribeToExecutionLogs(({ roomId, payload }) => {
        if (!roomId) return;

        // Drive gateway execution state machine off worker events.
        try {
            executionStateUpdater && executionStateUpdater(roomId, payload);
        } catch (e) {
            // ignore
        }

        const roomSet = rooms.getRoom(roomId);
        if (!roomSet) return;

        // Worker publishes EXECUTION_* payloads; forward them verbatim.
        if (payload && typeof payload === 'object') {
            broadcast(roomSet, payload);
        }
    });
}

module.exports = {
    pushJob,
    subscribeToExecutionLogs,
    forwardRedisLogsToRooms,
    setExecutionStateUpdater,
    EXECUTION_JOBS_LIST,
    LOG_CHANNEL_PREFIX
};
