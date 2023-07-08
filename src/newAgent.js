require('dotenv').config();
const api = require('./utils/api');
const { parseFile } = require('key-value-file');

// Initialize new account after server reset
const getNewAccount = async () => {
  const { agent, token } = await api.post('/register', {
    faction: process.env.SPACETRADERS_FACTION,
    symbol: process.env.SPACETRADERS_PREFIX,
    email: process.env.SPACETRADERS_EMAIL,
  });

  const envFile = await parseFile('../.env');
  await envFile
    .set('SPACETRADERS_TOKEN', token)
    .set('ACTIVE_SHIP', process.env.SPACETRADERS_PREFIX + '-1')
    .set('SPACETRADERS_ACCOUNTID', agent.accountId)
    .writeFile();

  console.log('Got new account and wrote new key.');
 }

getNewAccount();
