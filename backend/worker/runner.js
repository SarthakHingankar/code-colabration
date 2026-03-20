const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const { publishLog } = require('./queue');

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const DEFAULT_TIMEOUT_MS = Number(process.env.EXECUTION_TIMEOUT_MS || 10_000);

const EXECUTION_IMAGE = process.env.EXECUTION_IMAGE || 'execution-image:latest';
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';
const DEFAULT_MEMORY = process.env.EXECUTION_MEMORY || '128m';
const DEFAULT_CPUS = process.env.EXECUTION_CPUS || '0.5';

// A tiny pool of reusable staging containers. This avoids paying `docker create` for every job,
// which is noticeably slow on Docker Desktop / WSL2.
const STAGER_POOL_SIZE = Number(process.env.STAGER_POOL_SIZE || 2);
const STAGER_PREFIX = 'stager_exec_';
let stagerInitPromise = null;
const stagerQueue = [];

async function ensureStagerPool() {
    if (stagerInitPromise) return stagerInitPromise;
    stagerInitPromise = (async () => {
        for (let i = 0; i < STAGER_POOL_SIZE; i++) {
            const name = `${STAGER_PREFIX}${i}`;
            // Remove any existing container with that name (best-effort)
            try { await execDocker(['rm', '-f', name]); } catch { }
            // Create an idle container we can docker cp into, then commit.
            await execDocker(['create', '--name', name, EXECUTION_IMAGE, 'sh', '-lc', 'sleep 300']);
            stagerQueue.push(name);
        }
    })();
    return stagerInitPromise;
}

async function checkoutStager() {
    await ensureStagerPool();
    // naive wait loop; worker executes sequentially so contention is minimal.
    while (stagerQueue.length === 0) {
        await new Promise((r) => setTimeout(r, 25));
    }
    return stagerQueue.shift();
}

async function refreshAndReturnStager(name) {
    // Clean any changes and recreate from base image to keep runs independent.
    try { await execDocker(['rm', '-f', name]); } catch { }
    try {
        await execDocker(['create', '--name', name, EXECUTION_IMAGE, 'sh', '-lc', 'sleep 300']);
    } catch {
        // If recreate fails, drop it from the pool.
        return;
    }
    stagerQueue.push(name);
}

function execDocker(args, { input } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(DOCKER_BIN, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env
        });

        let stdout = '';
        let stderr = '';

        if (input != null) {
            p.stdin.write(input);
        }
        p.stdin.end();

        p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code === 0) return resolve({ stdout, stderr, code });
            const err = new Error(`docker ${args[0]} failed (code ${code}): ${stderr || stdout}`);
            err.code = code;
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
        });
    });
}

function ensureTmpDir() {
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function makeJobDir(executionId) {
    const safe = String(executionId || randomUUID()).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(TMP_DIR, `job_${safe}`);
}

function writeJobFiles(jobDir, code) {
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
    const filePath = path.join(jobDir, 'main.py');
    fs.writeFileSync(filePath, code || '', 'utf8');
    return filePath;
}

function rimrafSafe(p) {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
    } catch {
        // ignore
    }
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
    const jobDir = makeJobDir(executionId);
    const filePath = writeJobFiles(jobDir, job.code);

    // We avoid bind mounts entirely because they are unreliable with Docker Desktop
    // when controlling the host daemon from inside a container (dind / docker-outside-of-docker).
    // Instead, we copy the file into an isolated container via `docker cp`.
    await publishLog(roomId, {
        type: 'WORKER_DEBUG',
        executionId,
        msg: 'prepared job files',
        jobDir,
        filePath
    });

    // Preflight: ensure the file exists before we start docker.
    if (!fs.existsSync(filePath)) {
        await publishLog(roomId, { type: 'EXECUTION_ERROR', executionId, message: 'Sandbox preflight failed: main.py not found' });
        rimrafSafe(jobDir);
        return;
    }

    // Notify start
    await publishLog(roomId, { type: 'EXECUTION_STARTED', executionId });

    // Container name so we can force-kill on timeout.
    const containerName = `exec_${String(executionId || randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const stagedImage = `${EXECUTION_IMAGE}-staged-${String(executionId || randomUUID()).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    // Commit-based flow (known to work on Docker Desktop):
    // stage code into a non-readonly container, commit to a temp image,
    // then run that image with runtime hardening + read-only.
    const execPathInContainer = '/sandbox/main.py';

    // 1) Checkout a reusable staging container (WITHOUT --read-only) so docker cp can write.
    let stagerName;
    try {
        stagerName = await checkoutStager();
    } catch (e) {
        rimrafSafe(jobDir);
        await publishLog(roomId, { type: 'EXECUTION_ERROR', executionId, message: `Sandbox stager checkout failed: ${e.message}` });
        return;
    }

    // 2) Copy code into staging container
    try {
        await execDocker(['cp', filePath, `${stagerName}:${execPathInContainer}`]);
    } catch (e) {
        // Refresh the stager before returning it.
        refreshAndReturnStager(stagerName).catch(() => { });
        rimrafSafe(jobDir);
        await publishLog(roomId, { type: 'EXECUTION_ERROR', executionId, message: `Sandbox copy failed: ${e.message}` });
        return;
    }

    // 3) Commit staging container to an ephemeral image (now code is baked into the image)
    try {
        await execDocker(['commit', stagerName, stagedImage]);
    } catch (e) {
        refreshAndReturnStager(stagerName).catch(() => { });
        rimrafSafe(jobDir);
        await publishLog(roomId, { type: 'EXECUTION_ERROR', executionId, message: `Sandbox commit failed: ${e.message}` });
        return;
    } finally {
        // Refresh and return stager to pool (best-effort)
        refreshAndReturnStager(stagerName).catch(() => { });
    }

    // 4) Run the committed image with full hardening and stream logs
    const runName = `${containerName}_run`;
    const dockerArgs = [
        'run',
        '--rm',
        '--name', runName,
        '--memory', DEFAULT_MEMORY,
        '--cpus', DEFAULT_CPUS,
        '--pids-limit', String(process.env.EXECUTION_PIDS_LIMIT || 64),
        '--network', 'none',
        '--read-only',
        '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
        stagedImage,
        'python', execPathInContainer
    ];

    const proc = spawn(DOCKER_BIN, dockerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
    });

    let done = false;
    let timer = null;

    async function finishOnce(kind, payload) {
        if (done) return;
        done = true;

        if (timer) {
            clearTimeout(timer);
            timer = null;
        }

        // Cleanup temp image + any running container (best-effort)
        try {
            spawn(DOCKER_BIN, ['rm', '-f', runName], { stdio: 'ignore', env: process.env });
        } catch { }
        try {
            spawn(DOCKER_BIN, ['rmi', '-f', stagedImage], { stdio: 'ignore', env: process.env });
        } catch { }

        // cleanup temp job dir
        rimrafSafe(jobDir);

        if (kind === 'finished') {
            await publishLog(roomId, { type: 'EXECUTION_FINISHED', executionId, ...payload });
        } else {
            await publishLog(roomId, { type: 'EXECUTION_ERROR', executionId, message: payload?.message || String(payload) });
        }
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
        // Hard timeout: force-remove the container.
        try {
            spawn(DOCKER_BIN, ['rm', '-f', runName], { stdio: 'ignore', env: process.env });
        } catch (e) { }
        try { proc.kill(); } catch (e) { }
        finishOnce('error', { message: 'Execution timed out' }).catch(() => { });
    }, DEFAULT_TIMEOUT_MS);

    return {
        roomId,
        filePath,
        kill() {
            try { spawn(DOCKER_BIN, ['rm', '-f', runName], { stdio: 'ignore', env: process.env }); } catch (e) { }
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
