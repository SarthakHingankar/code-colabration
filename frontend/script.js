(function () {
    const editor = document.getElementById('editor');
    const newBtn = document.getElementById('newBtn');
    const saveBtn = document.getElementById('saveBtn');
    const clearBtn = document.getElementById('clearBtn');
    const openBtn = document.getElementById('openBtn');
    const status = document.getElementById('status');
    const words = document.getElementById('words');
    const chars = document.getElementById('chars');
    const fileInput = document.getElementById('fileInput');

    function updateCounts() {
        const text = editor.value || '';
        const ch = text.length;
        const w = text.trim() ? text.trim().split(/\s+/).length : 0;
        words.textContent = w;
        chars.textContent = ch;
    }

    function setStatus(t) {
        status.textContent = t;
        setTimeout(() => { if (status.textContent === t) status.textContent = 'Ready' }, 1800);
    }

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

    // initialize
    updateCounts();
    editor.focus();
})();
