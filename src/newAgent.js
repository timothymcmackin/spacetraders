require('dotenv').config();
const api = require('./utils/api');
const { parseFile } = require('key-value-file');
const axios = require('axios');
const path = require('path');

const client = axios.create({
  baseURL: 'https://api.spacetraders.io/v2/',
  timeout: 50000,
});

// Initialize new account after server reset
const getNewAccount = async () => {
  const response = await client.post('/register', {
    faction: process.env.SPACETRADERS_FACTION,
    symbol: process.env.SPACETRADERS_PREFIX,
    email: process.env.SPACETRADERS_EMAIL,
  });

  const { agent, token } = response.data.data;
  console.log(agent);
  console.log(token);

  const envFile = await parseFile(path.resolve(__dirname,'../.env'));
  await envFile
    .set('SPACETRADERS_TOKEN', token)
    .set('ACTIVE_SHIP', process.env.SPACETRADERS_PREFIX + '-1')
    .set('SPACETRADERS_ACCOUNTID', agent.accountId)
    .writeFile();

  console.log('Got new account and wrote new key.');
 }

getNewAccount();
