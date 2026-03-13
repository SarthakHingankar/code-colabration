const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});

server.on('error', (err) => {
    console.error('Server error:', err);
});