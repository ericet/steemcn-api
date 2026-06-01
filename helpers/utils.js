const Client = require('lightrpc');
const bluebird = require('bluebird');

const ENDPOINTS = [
  process.env.STEEMJS_URL || 'https://api.steemit.com',
  'https://steem.justyy.com',
  'https://api.justyy.com',
  'https://api.moecki.online',
  'https://api.campingclub.me',
  'https://api.wherein.io',
  'https://api2.justyy.com',
  'https://steemapi.boylikegirl.club',
];

let currentEndpointIndex = 0;
let client = new Client(ENDPOINTS[currentEndpointIndex]);
bluebird.promisifyAll(client);

const switchEndpoint = () => {
  currentEndpointIndex = (currentEndpointIndex + 1) % ENDPOINTS.length;
  const newEndpoint = ENDPOINTS[currentEndpointIndex];
  console.log(`Switching to endpoint: ${newEndpoint}`);
  client = new Client(newEndpoint);
  bluebird.promisifyAll(client);
  return client;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const getBlock = blockNum => client.sendAsync({ method: 'get_block', params: [blockNum] }, null);

const getOpsInBlock = (blockNum, onlyVirtual = false) =>
  client.sendAsync({ method: 'get_ops_in_block', params: [blockNum, onlyVirtual] }, null);

const getGlobalProps = () =>
  client.sendAsync({ method: 'get_dynamic_global_properties', params: [] }, null);

const mutliOpsInBlock = (start, limit, onlyVirtual = false) => {
  const request = [];
  for (let i = start; i < start + limit; i++) {
    request.push({ method: 'get_ops_in_block', params: [i, onlyVirtual] });
  }
  return client.sendBatchAsync(request, { timeout: 20000 });
};

const getBlockOps = block => {
  const operations = [];
  block.transactions.forEach(transaction => {
    operations.push(...transaction.operations);
  });
  return operations;
};

const retryWithFailover = async (fn, maxRetries = ENDPOINTS.length) => {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.error(`Request failed on ${ENDPOINTS[currentEndpointIndex]}:`, error.message);
      if (i < maxRetries - 1) {
        switchEndpoint();
      }
    }
  }
  throw lastError;
};

module.exports = {
  sleep,
  getBlock,
  getOpsInBlock,
  getGlobalProps,
  mutliOpsInBlock,
  getBlockOps,
  switchEndpoint,
  retryWithFailover,
};
