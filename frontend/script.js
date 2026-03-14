// Client-side socket will be created when user joins a room
let socket = null;
// Flag to prevent echoing remote updates back to server
let isRemoteUpdate = false;

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
        socket.send(JSON.stringify({
            type: 'RUN_CODE',
            roomId: currentRoomId
        }));
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

        // keep a reference to the current execution output element so we can stream into it
        let execPreElement = null;

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
                    addMessage('Execution started');
                }

                if (data.type === 'EXECUTION_OUTPUT') {
                    const outEl = document.getElementById('compilerOutput');
                    // accept multiple possible payload fields for streaming text
                    const text = (data.line ?? data.output ?? data.text ?? data.chunk) || '';

                    if (outEl) {
                        // ensure we have a single pre element to append text to
                        if (!execPreElement) {
                            execPreElement = document.createElement('pre');
                            execPreElement.className = 'compiler-output-line';
                            outEl.appendChild(execPreElement);
                        }

                        // if server indicates stream type, wrap chunk in a span so we can style stderr parts
                        if (data.stream === 'stderr') {
                            const span = document.createElement('span');
                            span.className = 'stderr';
                            span.textContent = text + '\n';
                            execPreElement.appendChild(span);
                        } else {
                            execPreElement.appendChild(document.createTextNode(text + '\n'));
                        }

                        // keep latest output in view
                        outEl.scrollTop = outEl.scrollHeight;
                    } else {
                        // fallback to messages panel if no compilerOutput exists
                        addMessage(text);
                    }
                }

                if (data.type === 'EXECUTION_FINISHED') {
                    addMessage('Code executed successfully');
                }

                if (data.type === 'EXECUTION_ERROR') {
                    addMessage(`Execution error: ${data.message}`);
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
