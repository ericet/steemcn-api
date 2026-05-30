const express = require('express');
const redis = require('../helpers/redis');

const router = express.Router();

const getUsername = req => req.body.username || req.query.username;

router.get('/', async (req, res) => {
  const username = getUsername(req);
  if (!username) {
    return res.status(400).send({ error: 'username is required' });
  }
  redis
    .lrangeAsync(`notifications:${username}`, 0, -1)
    .then(results => {
      const notifications = results.map(notification => JSON.parse(notification));
      res.send(notifications);
    })
    .catch(() => res.sendStatus(500));
});

router.post('/register', async (req, res) => {
  const username = getUsername(req);
  const token = req.body.token;
  if (!username || !token) {
    return res.status(400).send({ error: 'username and token are required' });
  }
  redis
    .saddAsync(`tokens:${username}`, token)
    .then(result => {
      if (result === 1) {
        // 1 token was added
        res.send({ message: 'registered' });
      } else {
        res.status(400).send({ error: 'already registered with this token' });
      }
    })
    .catch(() => res.sendStatus(500));
});

router.post('/unregister', async (req, res) => {
  const username = getUsername(req);
  const token = req.body.token;
  if (!username || !token) {
    return res.status(400).send({ error: 'username and token are required' });
  }
  redis
    .sremAsync(`tokens:${username}`, token)
    .then(result => {
      if (result === 1) {
        // 1 token removed from set
        res.send({ message: 'unregistered' });
      } else {
        res.status(404).send({ error: 'token not already registered' });
      }
    })
    .catch(() => res.sendStatus(500));
});

module.exports = router;
