const { MSG } = require('./constants');

function broadcast(roomSet, payload) {
    if (!roomSet) return;
    roomSet.forEach(client => {
        try {
            client.send(JSON.stringify(payload));
        } catch (e) {
            // ignore send errors per previous behaviour
        }
    });
}

module.exports = {
    broadcast
};
