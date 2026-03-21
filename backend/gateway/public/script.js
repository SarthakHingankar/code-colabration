// WebSocket is created on join.
let socket = null;
// Prevent echo of remote updates.
let isRemoteUpdate = false;
let executionRunning = false;

function createWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(protocol + '//' + location.host);
}

// UI + editor logic.
(function () {
    const joinScreen = document.getElementById('joinScreen');
    const joinBtn = document.getElementById('joinBtn');
    const roomInput = document.getElementById('roomInput');
    const joinStatus = document.getElementById('joinStatus');

    // Create room (project) controls
    const projectNameInput = document.getElementById('projectNameInput');
    const createProjectBtn = document.getElementById('createProjectBtn');
    const createdProject = document.getElementById('createdProject');
    const createdProjectId = document.getElementById('createdProjectId');
    const copyProjectIdBtn = document.getElementById('copyProjectIdBtn');
    const joinCreatedBtn = document.getElementById('joinCreatedBtn');

    const app = document.getElementById('app');
    const roomIdLabel = document.getElementById('roomIdLabel');
    const userCount = document.getElementById('userCount');
    const messagesList = document.getElementById('messagesList');

    const editor = document.getElementById('editor');
    const newBtn = document.getElementById('newBtn');
    const saveBtn = document.getElementById('saveBtn');
    const clearBtn = document.getElementById('clearBtn');
    const openBtn = document.getElementById('openBtn');
    const status = document.getElementById('status');
    const connBadge = document.getElementById('connBadge');
    const words = document.getElementById('words');
    const chars = document.getElementById('chars');
    const fileInput = document.getElementById('fileInput');
    const runBtn = document.getElementById('runBtn');
    let currentRoomId = null;

    function setStatus(t) {
        status.textContent = t;
        setTimeout(() => { if (status.textContent === t) status.textContent = 'Ready' }, 1800);
    }

    function setConnBadge(state) {
        if (!connBadge) return;
        connBadge.classList.remove('ok', 'bad');
        if (state === 'ok') {
            connBadge.textContent = 'Connected';
            connBadge.classList.add('ok');
        } else if (state === 'bad') {
            connBadge.textContent = 'Disconnected';
            connBadge.classList.add('bad');
        } else {
            connBadge.textContent = 'Connecting';
        }
    }

    function updateCounts() {
        const text = editor.value || '';
        const ch = text.length;
        const w = text.trim() ? text.trim().split(/\s+/).length : 0;
        words.textContent = w;
        chars.textContent = ch;
    }

    function updateUserCount(users) {
        // users can be number or array
        if (Array.isArray(users)) {
            userCount.textContent = `${users.length} users`;
        } else if (typeof users === 'number') {
            userCount.textContent = `${users} users`;
        } else {
            userCount.textContent = `${users || 0} users`;
        }
    }

    function addMessage(text, type) {
        const div = document.createElement('div');
        div.textContent = text;
        if (type === 'system') div.classList.add('msg-system');
        messagesList.appendChild(div);
        messagesList.scrollTop = messagesList.scrollHeight;
        // Mark messages tab unread.
        const msgTab = document.querySelector('.tabs .tab[data-tab="messages"]');
        if (msgTab && !msgTab.classList.contains('active')) msgTab.classList.add('has-unread');
    }

    // Editor buttons
    newBtn.addEventListener('click', () => {
        if (editor.value && !confirm('Discard current contents and create new file?')) return;
        editor.value = '';
        editor.focus();
        updateCounts();
        setStatus('New');
    });

    clearBtn.addEventListener('click', () => {
        if (!editor.value) return;
        if (!confirm('Clear editor contents?')) return;
        editor.value = '';
        updateCounts();
        setStatus('Cleared');
    });

    saveBtn.addEventListener('click', () => {
        const text = editor.value || '';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'untitled.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatus('Downloaded');
    });

    openBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = ev => {
            editor.value = ev.target.result;
            updateCounts();
            setStatus('File loaded');
        };
        reader.readAsText(f);
    });

    editor.addEventListener('input', () => {
        updateCounts();
        // Broadcast local edits.
        if (!isRemoteUpdate && socket && socket.readyState === WebSocket.OPEN && currentRoomId) {
            try {
                socket.send(JSON.stringify({
                    type: 'CODE_UPDATE',
                    roomId: currentRoomId,
                    code: editor.value
                }));
            } catch (e) {
                console.error('Failed to send CODE_UPDATE', e);
            }
        }
    });

    runBtn && runBtn.addEventListener('click', () => {
        if (executionRunning) return;
        if (socket && socket.readyState === WebSocket.OPEN && currentRoomId) {
            socket.send(JSON.stringify({
                type: 'RUN_CODE',
                roomId: currentRoomId
            }));
        }
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            saveBtn.click();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            newBtn.click();
        }
    });

    // Tabs
    document.querySelectorAll('.tabs .tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const t = btn.dataset.tab;
            document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
            if (t === 'info') document.getElementById('infoTab').classList.remove('hidden');
            if (t === 'messages') {
                document.getElementById('messagesTab').classList.remove('hidden');
                // Clear unread badge.
                btn.classList.remove('has-unread');
            }
        });
    });

    function joinRoomById(roomId) {
        roomId = (roomId || '').trim();
        if (!roomId) {
            joinStatus.textContent = 'Please enter a room id';
            return;
        }

        joinStatus.textContent = 'Connecting...';
        setConnBadge('');

        // Set early for INITIAL_CODE.
        currentRoomId = roomId;

        socket = createWebSocket();

        socket.onopen = () => {
            setConnBadge('ok');
            // Send join.
            socket.send(JSON.stringify({ type: 'JOIN_ROOM', roomId }));
        };

        socket.onclose = () => {
            setConnBadge('bad');
            addMessage('Disconnected from server', 'system');
        };

        socket.onerror = (err) => {
            console.error('Socket error', err);
            setConnBadge('bad');
            joinStatus.textContent = 'Socket error';
        };

        // Per-run output state
        let execPreElement = null;

        // Output cap + throttled DOM writes.
        const MAX_OUTPUT_CHARS = 50_000;
        const FLUSH_INTERVAL_MS = 75;

        let pendingOutput = '';
        let outputBuffer = '';
        let flushTimer = null;
        let flushScheduled = false;

        function scheduleFlush() {
            if (flushScheduled) return;
            flushScheduled = true;
            flushTimer = setTimeout(() => {
                flushScheduled = false;
                flushOutputToDom();
            }, FLUSH_INTERVAL_MS);
        }

        function trimBuffer(buf) {
            if (buf.length <= MAX_OUTPUT_CHARS) return buf;
            const trimmed = buf.slice(buf.length - MAX_OUTPUT_CHARS);
            return trimmed;
        }

        function flushOutputToDom() {
            if (!pendingOutput) return;
            outputBuffer = trimBuffer(outputBuffer + pendingOutput);
            pendingOutput = '';

            const outEl = document.getElementById('compilerOutput');
            if (!outEl) return;

            if (!execPreElement) {
                execPreElement = document.createElement('pre');
                execPreElement.className = 'compiler-output-line';
                outEl.appendChild(execPreElement);
            }

            execPreElement.textContent = outputBuffer;
            outEl.scrollTop = outEl.scrollHeight;
        }

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'ROOM_JOINED') {
                    currentRoomId = data.roomId || roomId;
                    roomIdLabel.textContent = currentRoomId;
                    updateUserCount(data.users);
                    // Switch UI
                    joinScreen.classList.add('hidden');
                    app.classList.remove('hidden');
                    joinStatus.textContent = 'Joined';
                    // System message
                    addMessage(`Joined room ${data.roomId}`, 'system');
                    if (data.users) addMessage(`Users in room: ${Array.isArray(data.users) ? data.users.length : data.users}`, 'system');
                    // Populate editor (no echo).
                    if (typeof data.code === 'string') {
                        isRemoteUpdate = true;
                        editor.value = data.code;
                        updateCounts();
                        isRemoteUpdate = false;
                        addMessage('Loaded room code', 'system');
                    }
                }

                // INITIAL_CODE join flow.
                if (data.type === 'INITIAL_CODE') {
                    currentRoomId = currentRoomId || roomId;
                    roomIdLabel.textContent = currentRoomId;
                    // Switch UI
                    joinScreen.classList.add('hidden');
                    app.classList.remove('hidden');
                    joinStatus.textContent = 'Joined';
                    addMessage(`Joined room ${currentRoomId}`, 'system');

                    if (typeof data.code === 'string') {
                        isRemoteUpdate = true;
                        editor.value = data.code;
                        updateCounts();
                        isRemoteUpdate = false;
                        addMessage('Loaded project code', 'system');
                    }
                }

                if (data.type === 'ERROR') {
                    const msg = data.message || 'Unknown error';
                    joinStatus.textContent = msg;
                    addMessage(`Error: ${msg}`, 'system');
                    console.error('Server ERROR:', data);
                }

                if (data.type === 'USER_JOINED') {
                    updateUserCount(data.users);
                    const who = data.user || 'A user';
                    addMessage(`${who} joined the room.`, 'system');
                }

                if (data.type === 'USER_LEFT') {
                    updateUserCount(data.users);
                    const whoLeft = data.user || 'A user';
                    addMessage(`${whoLeft} left the room.`, 'system');
                }

                if (data.type === 'CODE_UPDATE') {
                    // Apply remote update (no echo).
                    isRemoteUpdate = true;
                    editor.value = data.code || '';
                    updateCounts();
                    isRemoteUpdate = false;
                }

                if (data.type === 'MESSAGE') {
                    if (data.user) addMessage(`${data.user}: ${data.text || JSON.stringify(data)}`);
                    else addMessage(data.text || JSON.stringify(data));
                }
                if (data.type === 'EXECUTION_STARTED') {
                    executionRunning = true;
                    if (runBtn) runBtn.disabled = true;
                    addMessage('Execution started');
                    setStatus('Running…');

                    // Fresh output session
                    const outEl = document.getElementById('compilerOutput');
                    if (outEl) outEl.textContent = '';
                    execPreElement = null;

                    // Reset buffers/timers
                    pendingOutput = '';
                    outputBuffer = '';
                    if (flushTimer) {
                        clearTimeout(flushTimer);
                        flushTimer = null;
                    }
                    flushScheduled = false;
                }

                if (data.type === 'EXECUTION_OUTPUT') {
                    const text = (data.line ?? data.output ?? data.text ?? data.chunk) || '';

                    // Buffer then flush (throttled).
                    const chunk = text + (text.endsWith('\n') ? '' : '\n');
                    pendingOutput += chunk;

                    const outEl = document.getElementById('compilerOutput');
                    if (!outEl) {
                        addMessage(text);
                        pendingOutput = '';
                        return;
                    }

                    if (data.stream === 'stderr' && execPreElement) execPreElement.classList.add('stderr');

                    if (pendingOutput.length > 16_000) {
                        flushOutputToDom();
                    } else {
                        scheduleFlush();
                    }
                }

                if (data.type === 'EXECUTION_FINISHED') {
                    executionRunning = false;
                    if (runBtn) runBtn.disabled = false;
                    flushOutputToDom();
                    addMessage('Code executed successfully');
                    setStatus('Finished');
                }

                if (data.type === 'EXECUTION_ERROR') {
                    executionRunning = false;
                    if (runBtn) runBtn.disabled = false;
                    flushOutputToDom();
                    addMessage(`Execution error: ${data.message}`);
                    setStatus('Error');
                }
                if (data.type === 'EXECUTION_ALREADY_RUNNING') {
                    executionRunning = true;
                    if (runBtn) runBtn.disabled = true;
                    addMessage('Execution already in progress', 'system');
                }

            } catch (e) {
                console.error('Failed to parse socket message', e);
            }
        };
    }

    joinBtn.addEventListener('click', () => {
        joinRoomById(roomInput.value);
    });

    createProjectBtn && createProjectBtn.addEventListener('click', async () => {
        if (createProjectBtn.disabled) return;

        createProjectBtn.disabled = true;
        joinBtn.disabled = true;
        joinStatus.textContent = 'Creating room...';
        if (createProjectBtn) createProjectBtn.textContent = 'Creating…';

        try {
            const resp = await fetch('/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: (projectNameInput?.value || '').trim() || 'Untitled Project' })
            });

            if (!resp.ok) {
                const txt = await resp.text().catch(() => '');
                throw new Error(txt || `Request failed (${resp.status})`);
            }

            const data = await resp.json();
            const id = data && data.projectId;
            if (!id) throw new Error('Server did not return projectId');

            if (createdProjectId) createdProjectId.textContent = id;
            if (createdProject) createdProject.classList.remove('hidden');
            roomInput.value = id;
            joinStatus.textContent = 'Room created.';
        } catch (e) {
            console.error(e);
            joinStatus.textContent = e?.message || 'Failed to create room';
        } finally {
            createProjectBtn.disabled = false;
            joinBtn.disabled = false;
            if (createProjectBtn) createProjectBtn.textContent = 'Create room';
        }
    });

    joinCreatedBtn && joinCreatedBtn.addEventListener('click', () => {
        const id = (createdProjectId && createdProjectId.textContent) || '';
        joinRoomById(id);
    });

    copyProjectIdBtn && copyProjectIdBtn.addEventListener('click', async () => {
        const id = (createdProjectId && createdProjectId.textContent) || '';
        if (!id || id === '-') return;
        try {
            await navigator.clipboard.writeText(id);
            joinStatus.textContent = 'Copied room ID to clipboard';
            copyProjectIdBtn.textContent = 'Copied!';
            setTimeout(() => { copyProjectIdBtn.textContent = 'Copy ID'; }, 900);
        } catch {
            roomInput.focus();
            roomInput.select();
            joinStatus.textContent = 'Select room ID and copy (Ctrl+C)';
        }
    });

    // Init
    updateCounts();
    roomInput.focus();

})();
