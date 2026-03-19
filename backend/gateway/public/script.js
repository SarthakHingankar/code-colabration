// Client-side socket will be created when user joins a room
let socket = null;
// Flag to prevent echoing remote updates back to server
let isRemoteUpdate = false;
let executionRunning = false;

function createWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(protocol + '//' + location.host);
}

// UI helpers and editor logic
(function () {
    const joinScreen = document.getElementById('joinScreen');
    const joinBtn = document.getElementById('joinBtn');
    const roomInput = document.getElementById('roomInput');
    const joinStatus = document.getElementById('joinStatus');

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
    const words = document.getElementById('words');
    const chars = document.getElementById('chars');
    const fileInput = document.getElementById('fileInput');
    const runBtn = document.getElementById('runBtn');
    let currentRoomId = null;

    function setStatus(t) {
        status.textContent = t;
        setTimeout(() => { if (status.textContent === t) status.textContent = 'Ready' }, 1800);
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
        // mark messages tab as having unread messages unless it's already active
        const msgTab = document.querySelector('.tabs .tab[data-tab="messages"]');
        if (msgTab && !msgTab.classList.contains('active')) msgTab.classList.add('has-unread');
    }

    // editor buttons
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
        // Broadcast edits to room unless this update originated remotely
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

    // keyboard shortcuts
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

    // tabs
    document.querySelectorAll('.tabs .tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const t = btn.dataset.tab;
            document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
            if (t === 'info') document.getElementById('infoTab').classList.remove('hidden');
            if (t === 'messages') {
                document.getElementById('messagesTab').classList.remove('hidden');
                // clear unread badge when user views messages
                btn.classList.remove('has-unread');
            }
        });
    });

    // Join flow
    joinBtn.addEventListener('click', () => {
        const roomId = (roomInput.value || '').trim();
        if (!roomId) {
            joinStatus.textContent = 'Please enter a room id';
            return;
        }

        joinStatus.textContent = 'Connecting...';
        socket = createWebSocket();

        socket.onopen = () => {
            console.log('Connected to server');
            // Send join message
            socket.send(JSON.stringify({ type: 'JOIN_ROOM', roomId }));
        };

        socket.onclose = () => {
            console.log('Disconnected from server');
            addMessage('Disconnected from server', 'system');
        };

        socket.onerror = (err) => {
            console.error('Socket error', err);
            joinStatus.textContent = 'Socket error';
        };

        // per-run output state
        let execPreElement = null;

        // Output backpressure/cap to prevent infinite output from freezing the tab.
        // Keep only the last MAX_OUTPUT_CHARS characters and throttle DOM writes.
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
            // Keep tail
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
                    console.log('Joined room', data.roomId);
                    currentRoomId = data.roomId || roomId;
                    roomIdLabel.textContent = currentRoomId;
                    updateUserCount(data.users);
                    // switch UI
                    joinScreen.classList.add('hidden');
                    app.classList.remove('hidden');
                    joinStatus.textContent = 'Joined';
                    // show system message in messages tab
                    addMessage(`Joined room ${data.roomId}`, 'system');
                    if (data.users) addMessage(`Users in room: ${Array.isArray(data.users) ? data.users.length : data.users}`, 'system');
                    // If server provided the current code for the room, populate editor without echo
                    if (typeof data.code === 'string') {
                        isRemoteUpdate = true;
                        editor.value = data.code;
                        updateCounts();
                        isRemoteUpdate = false;
                        addMessage('Loaded room code', 'system');
                    }
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
                    // apply remote code update without echoing back
                    isRemoteUpdate = true;
                    editor.value = data.code || '';
                    updateCounts();
                    isRemoteUpdate = false;
                }

                if (data.type === 'MESSAGE') {
                    // if server sends chat messages with user info
                    if (data.user) addMessage(`${data.user}: ${data.text || JSON.stringify(data)}`);
                    else addMessage(data.text || JSON.stringify(data));
                }
                if (data.type === 'EXECUTION_STARTED') {
                    executionRunning = true;
                    if (runBtn) runBtn.disabled = true;
                    console.log('Execution started');
                    addMessage('Execution started');

                    // start a fresh output session
                    const outEl = document.getElementById('compilerOutput');
                    if (outEl) outEl.textContent = '';
                    execPreElement = null;

                    // reset output buffers/timers for this run
                    pendingOutput = '';
                    outputBuffer = '';
                    if (flushTimer) {
                        clearTimeout(flushTimer);
                        flushTimer = null;
                    }
                    flushScheduled = false;
                }

                if (data.type === 'EXECUTION_OUTPUT') {
                    // accept multiple possible payload fields for streaming text
                    const text = (data.line ?? data.output ?? data.text ?? data.chunk) || '';

                    // Backpressured streaming: buffer then flush at a throttled cadence.
                    // Also cap growth so infinite output can't crash the page.
                    const chunk = text + (text.endsWith('\n') ? '' : '\n');
                    pendingOutput += chunk;

                    // Small optimization: if output panel doesn't exist, don't buffer forever.
                    const outEl = document.getElementById('compilerOutput');
                    if (!outEl) {
                        addMessage(text);
                        pendingOutput = '';
                        return;
                    }

                    // If stderr is present, mark the whole run as having stderr output.
                    if (data.stream === 'stderr' && execPreElement) execPreElement.classList.add('stderr');

                    // If pending output is already huge, flush immediately to keep memory stable.
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
                }

                if (data.type === 'EXECUTION_ERROR') {
                    executionRunning = false;
                    if (runBtn) runBtn.disabled = false;
                    flushOutputToDom();
                    addMessage(`Execution error: ${data.message}`);
                }
                if (data.type === 'EXECUTION_ALREADY_RUNNING') {
                    // Keep UI in running state; just inform the user.
                    executionRunning = true;
                    if (runBtn) runBtn.disabled = true;
                    addMessage('Execution already in progress', 'system');
                }

            } catch (e) {
                console.error('Failed to parse socket message', e);
            }
        };
    });

    // initialize counts
    updateCounts();
    // focus room input initially
    roomInput.focus();

})();
