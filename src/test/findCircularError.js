require('dotenv').config();
const argv = require('minimist')(process.argv.slice(2));

const {
  navigate,
  // sellAll,
} = require('./utils');

const main = () => {

  const activeShip = process.env.ACTIVE_SHIP;

  const cmd = argv['_'][0];
  switch (cmd) {
    case 'navigate':
      // await navigate()
      console.log('Navigating', activeShip, 'to', argv['_'][1]);
      break;

    default:
      break;
  }
}
main();