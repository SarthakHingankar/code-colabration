const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;

// Dedicated clients for collaboration bus.
// (Keep separate from blocking queue clients / other redis usage.)
const pub = REDIS_URL ? new Redis(REDIS_URL) : null;
const sub = REDIS_URL ? new Redis(REDIS_URL) : null;

module.exports = { pub, sub };
