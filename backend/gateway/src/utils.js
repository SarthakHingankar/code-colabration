const { MSG } = require('../../shared/constants');

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

function logger(...args) {
    console.log(...args);
}

module.exports = {
    broadcast,
    logger
};
