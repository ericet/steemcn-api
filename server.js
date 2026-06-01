const _ = require('lodash');
const express = require('express');
const SocketServer = require('ws').Server;
const LightrpcClient = require('lightrpc');
const bodyParser = require('body-parser');
const redis = require('./helpers/redis');
const utils = require('./helpers/utils');
const router = require('./routes');
const notificationUtils = require('./helpers/expoNotifications');

const NOTIFICATION_EXPIRY = 7 * 24 * 3600;
const LIMIT = 1000;
const BATCH_SIZE = 10;
const MAX_RETRIES = 3;
let startingBlock = null;
const blockRetries = {}; // Track retry attempts per block

const app = express();
app.use(bodyParser.json());
app.use('/', router);

const port = process.env.PORT || 4000;
const server = app.listen(port, () => console.log(`Listening on ${port}`));

const wss = new SocketServer({ server });

const steemApiUrl =
  process.env.STEEMJS_URL || process.env.STEEMD_WS_URL || 'https://api.steemit.com';
const rpcClient = new LightrpcClient(steemApiUrl);

const cache = {};
const useCache = false;

const clearGC = () => {
  try {
    global.gc();
  } catch (e) {
    console.log("You must run program with 'node --expose-gc index.js' or 'npm start'");
  }
};

setInterval(clearGC, 60 * 1000);

/** Init websocket server */

wss.on('connection', ws => {
  console.log('Got connection from new peer');
  ws.on('message', message => {
    console.log('Message', message);
    let call = {};
    try {
      call = JSON.parse(message);
    } catch (e) {
      console.error('Error WS parse JSON message', message, e);
    }
    // const key = new Buffer(JSON.stringify([call.method, call.params])).toString('base64');
    if (call.method === 'get_notifications' && call.params && call.params[0]) {
      redis
        .lrangeAsync(`notifications:${call.params[0]}`, 0, -1)
        .then(res => {
          console.log('Send notifications', call.params[0], res.length);
          const notifications = res.map(notification => JSON.parse(notification));
          ws.send(JSON.stringify({ id: call.id, result: notifications }));
        })
        .catch(err => {
          console.log('Redis get_notifications failed', err);
        });
      // } else if (useCache && cache[key]) {
      //  ws.send(JSON.stringify({ id: call.id, cache: true, result: cache[key] }));
    } else if (call.method === 'subscribe' && call.params && call.params[0]) {
      console.log('Subscribe success', call.params[0]);
      ws.name = call.params[0];
      ws.send(
        JSON.stringify({ id: call.id, result: { subscribe: true, username: call.params[0] } }),
      );
    } else if (call.method && call.params) {
      rpcClient.send({ method: call.method, params: call.params }, (err, result) => {
        if (err) {
          console.error('RPC call failed', call.method, err);
          ws.send(
            JSON.stringify({
              id: call.id,
              error: err.message || 'RPC call failed',
            }),
          );
          return;
        }
        ws.send(JSON.stringify({ id: call.id, result }));
        // if (useCache) {
        //  cache[key] = result;
        // }
      });
    } else {
      ws.send(
        JSON.stringify({
          id: call.id,
          result: {},
          error: 'Something is wrong',
        }),
      );
    }
  });
  ws.on('error', () => console.log('Error on connection with peer'));
  ws.on('close', () => console.log('Connection with peer closed'));
});

/** Stream the blockchain for notifications */

const getNotifications = ops => {
  const notifications = [];
  const voteGroups = {}; // Group votes by author+block
  
  ops.forEach(op => {
    const type = op.op[0];
    const params = op.op[1];
    switch (type) {
      case 'comment': {
        const isRootPost = !params.parent_author;
        /** Find replies */
        if (!isRootPost) {
          const notification = {
            type: 'reply',
            parent_permlink: params.parent_permlink,
            author: params.author,
            permlink: params.permlink,
            timestamp: Date.parse(op.timestamp) / 1000,
            block: op.block,
          };
          notifications.push([params.parent_author, notification]);
        }

        /** Find mentions */
        const pattern = /(@[a-z][-\.a-z\d]+[a-z\d])/gi;
        const content = `${params.title} ${params.body}`;
        const mentions = _
          .without(
            _
              .uniq(
                (content.match(pattern) || [])
                  .join('@')
                  .toLowerCase()
                  .split('@'),
              )
              .filter(n => n),
            params.author,
          )
          .slice(0, 9); // Handle maximum 10 mentions per post
        if (mentions.length) {
          mentions.forEach(mention => {
            const notification = {
              type: 'mention',
              is_root_post: isRootPost,
              author: params.author,
              permlink: params.permlink,
              timestamp: Date.parse(op.timestamp) / 1000,
              block: op.block,
            };
            notifications.push([mention, notification]);
          });
        }
        break;
      }
      case 'custom_json': {
        let json = {};
        try {
          json = JSON.parse(params.json);
        } catch (err) {
          console.log('Wrong json format on custom_json', err);
        }
        switch (params.id) {

          case 'follow': {
            /** Find follow */
            if (
              json[0] === 'follow' &&
              json[1].follower &&
              json[1].following &&
              _.has(json, '[1].what[0]') &&
              json[1].what[0] === 'blog'
            ) {
              const notification = {
                type: 'follow',
                follower: json[1].follower,
                timestamp: Date.parse(op.timestamp) / 1000,
                block: op.block,
              };
              notifications.push([json[1].following, notification]);
            }
            /** Find reblog */
            if (json[0] === 'reblog' && json[1].account && json[1].author && json[1].permlink) {
              const notification = {
                type: 'reblog',
                account: json[1].account,
                permlink: json[1].permlink,
                timestamp: Date.parse(op.timestamp) / 1000,
                block: op.block,
              };
              // console.log('Reblog', [json[1].author, JSON.stringify(notification)]);
              notifications.push([json[1].author, notification]);
            }
            break;
          }
        }
        break;
      }
      case 'account_witness_vote': {
        /** Find witness vote */
        const notification = {
          type: 'witness_vote',
          account: params.account,
          approve: params.approve,
          timestamp: Date.parse(op.timestamp) / 1000,
          block: op.block,
        };
        // console.log('Witness vote', [params.witness, notification]);
        notifications.push([params.witness, notification]);
        break;
      }
      case 'vote': {
        const groupKey = `${params.author}:${op.block}`;
        if (!voteGroups[groupKey]) {
          voteGroups[groupKey] = {
            author: params.author,
            block: op.block,
            timestamp: Date.parse(op.timestamp) / 1000,
            upvotes: [],
            downvotes: [],
          };
        }
        
        const voteData = {
          voter: params.voter,
          permlink: params.permlink,
          weight: params.weight,
        };
        
        if (params.weight < 0) {
          voteGroups[groupKey].downvotes.push(voteData);
        } else {
          voteGroups[groupKey].upvotes.push(voteData);
        }
        break;
      }
      case 'transfer': {
        /** Find transfer */
        const notification = {
          type: 'transfer',
          from: params.from,
          amount: params.amount,
          memo: params.memo,
          timestamp: Date.parse(op.timestamp) / 1000,
          block: op.block,
        };
        // console.log('Transfer', JSON.stringify([params.to, notification]));
        notifications.push([params.to, notification]);
        break;
      }
    }
  });
  
  // Convert vote groups into notifications
  Object.values(voteGroups).forEach(group => {
    if (group.upvotes.length > 0) {
      const notification = {
        type: 'vote',
        block: group.block,
        timestamp: group.timestamp,
        count: group.upvotes.length,
        votes: group.upvotes,
      };
      notifications.push([group.author, notification]);
    }
    
    if (group.downvotes.length > 0) {
      const notification = {
        type: 'downvote',
        block: group.block,
        timestamp: group.timestamp,
        count: group.downvotes.length,
        votes: group.downvotes,
      };
      notifications.push([group.author, notification]);
    }
  });
  
  return notifications;
};

const skipBlock = (blockNum) => {
  console.log(`Skipping block ${blockNum} after ${MAX_RETRIES} failed attempts`);
  delete blockRetries[blockNum];
  redis
    .setAsync('last_block_num', blockNum)
    .then(() => {
      loadNextBlock();
    })
    .catch(err => {
      console.error('Redis set last_block_num failed during skip', err);
      loadNextBlock();
    });
};

const loadBlock = blockNum => {
  // Initialize retry counter for this block
  if (!blockRetries[blockNum]) {
    blockRetries[blockNum] = 0;
  }

  utils
    .getOpsInBlock(blockNum, false)
    .then(ops => {
      if (!ops.length) {
        console.error('Block does not exit?', blockNum);
        utils
          .getBlock(blockNum)
          .then(block => {
            if (block && block.previous && block.transactions.length === 0) {
              console.log('Block exist and is empty, load next', blockNum);
              delete blockRetries[blockNum];
              redis
                .setAsync('last_block_num', blockNum)
                .then(() => {
                  loadNextBlock();
                })
                .catch(err => {
                  console.error('Redis set last_block_num failed', err);
                  blockRetries[blockNum]++;
                  if (blockRetries[blockNum] >= MAX_RETRIES) {
                    skipBlock(blockNum);
                  } else {
                    loadBlock(blockNum);
                  }
                });
            } else {
              blockRetries[blockNum]++;
              if (blockRetries[blockNum] >= MAX_RETRIES) {
                skipBlock(blockNum);
              } else {
                console.log(`Sleep and retry (${blockRetries[blockNum]}/${MAX_RETRIES})`, blockNum);
                utils.sleep(2000).then(() => {
                  loadBlock(blockNum);
                });
              }
            }
          })
          .catch(err => {
            blockRetries[blockNum]++;
            if (blockRetries[blockNum] >= MAX_RETRIES) {
              skipBlock(blockNum);
            } else {
              console.log(
                `Error lightrpc (getBlock), sleep and retry (${blockRetries[blockNum]}/${MAX_RETRIES})`,
                blockNum,
                JSON.stringify(err),
              );
              utils.sleep(2000).then(() => {
                loadBlock(blockNum);
              });
            }
          });
      } else {
        try {
          const notifications = getNotifications(ops);
          /** Create redis operations array */
          const redisOps = [];
          notifications.forEach(notification => {
            const key = `notifications:${notification[0]}`
            redisOps.push([
              'lpush',
              key,
              JSON.stringify(notification[1]),
            ]);
            redisOps.push(['expire', key, NOTIFICATION_EXPIRY]);
            redisOps.push(['ltrim', key, 0, LIMIT - 1]);
          });
          redisOps.push(['set', 'last_block_num', blockNum]);
          redis
            .multi(redisOps)
            .execAsync()
            .then(() => {
              console.log('Block loaded', blockNum, 'notification stored', notifications.length);
              delete blockRetries[blockNum];

              /** Send push notification for logged peers */
              notifications.forEach(notification => {
                wss.clients.forEach(client => {
                  if (client.name && client.name === notification[0]) {
                    console.log('Send push notification', notification[0]);
                    client.send(
                      JSON.stringify({
                        type: 'notification',
                        notification: notification[1],
                      }),
                    );
                  }
                });
              });
              /** Send notifications to all devices */
              notificationUtils.sendAllNotifications(notifications);
              loadNextBlock();
            })
            .catch(err => {
              console.error('Redis store notification multi failed', err);
              blockRetries[blockNum]++;
              if (blockRetries[blockNum] >= MAX_RETRIES) {
                skipBlock(blockNum);
              } else {
                loadBlock(blockNum);
              }
            });
        } catch (err) {
          console.error('Error processing block notifications', blockNum, err);
          blockRetries[blockNum]++;
          if (blockRetries[blockNum] >= MAX_RETRIES) {
            skipBlock(blockNum);
          } else {
            utils.sleep(2000).then(() => {
              loadBlock(blockNum);
            });
          }
        }
      }
    })
    .catch(err => {
      console.error('Call failed with lightrpc (getOpsInBlock)', err);
      blockRetries[blockNum]++;
      if (blockRetries[blockNum] >= MAX_RETRIES) {
        skipBlock(blockNum);
      } else {
        console.log(`Retry (${blockRetries[blockNum]}/${MAX_RETRIES})`, blockNum);
        utils.sleep(2000).then(() => {
          loadBlock(blockNum);
        });
      }
    });
};

const loadBlocksBatch = async (startBlock, endBlock) => {
  try {
    const batchSize = endBlock - startBlock + 1;
    const results = await utils.mutliOpsInBlock(startBlock, batchSize, false);
    
    const allNotifications = [];
    results.forEach((ops, index) => {
      if (ops && ops.length > 0) {
        const blockNum = startBlock + index;
        const notifications = getNotifications(ops);
        allNotifications.push(...notifications);
      }
    });

    const redisOps = [];
    allNotifications.forEach(notification => {
      const key = `notifications:${notification[0]}`;
      redisOps.push(['lpush', key, JSON.stringify(notification[1])]);
      redisOps.push(['expire', key, NOTIFICATION_EXPIRY]);
      redisOps.push(['ltrim', key, 0, LIMIT - 1]);
    });
    redisOps.push(['set', 'last_block_num', endBlock]);

    await redis.multi(redisOps).execAsync();
    console.log(`Batch loaded blocks ${startBlock}-${endBlock}, notifications stored: ${allNotifications.length}`);

    allNotifications.forEach(notification => {
      wss.clients.forEach(client => {
        if (client.name && client.name === notification[0]) {
          client.send(JSON.stringify({
            type: 'notification',
            notification: notification[1],
          }));
        }
      });
    });

    notificationUtils.sendAllNotifications(allNotifications);
    loadNextBlock();
  } catch (err) {
    console.error('Batch load failed, falling back to single block:', err);
    loadBlock(startBlock);
  }
};

const loadNextBlock = () => {
  redis
    .getAsync('last_block_num')
    .then(res => {
      let nextBlockNum = res === null ? startingBlock : parseInt(res) + 1;
      utils
        .getGlobalProps()
        .then(globalProps => {
          const lastIrreversibleBlockNum = globalProps.last_irreversible_block_num;
          const blocksToSync = lastIrreversibleBlockNum - nextBlockNum + 1;
          
          if (blocksToSync > 0) {
            if (blocksToSync >= BATCH_SIZE) {
              const endBlock = nextBlockNum + BATCH_SIZE - 1;
              loadBlocksBatch(nextBlockNum, endBlock);
            } else {
              loadBlock(nextBlockNum);
            }
          } else {
            utils.sleep(2000).then(() => {
              console.log(
                'Waiting to be on the lastIrreversibleBlockNum',
                lastIrreversibleBlockNum,
                'now nextBlockNum',
                nextBlockNum,
              );
              loadNextBlock();
            });
          }
        })
        .catch(err => {
          console.error('Call failed with lightrpc (getGlobalProps)', err);
          utils.sleep(2000).then(() => {
            console.log('Retry loadNextBlock', nextBlockNum);
            loadNextBlock();
          });
        });
    })
    .catch(err => {
      console.error('Redis get last_block_num failed', err);
    });
};

const start = async () => {
  console.info('Start streaming blockchain');
  
  try {
    const globalProps = await utils.getGlobalProps();
    startingBlock = globalProps.last_irreversible_block_num - 100000;
    console.log(`Starting block set to: ${startingBlock} (current - 100000)`);
  } catch (err) {
    console.error('Failed to get global props, using fallback starting block');
    startingBlock = 106315725;
  }
  
  loadNextBlock();

  /** Send heartbeat to peers */
  setInterval(() => {
    wss.clients.forEach(client => {
      client.send(JSON.stringify({ type: 'heartbeat' }));
    });
  }, 20 * 1000);
};

// redis.flushallAsync();
start();
