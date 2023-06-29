require('dotenv').config();
const {
  navigate,
  // sellAll,
} = require('./utils');
const {
  post,
  get,
} = require('./api');
const argv = require('minimist')(process.argv.slice(2));

/* minimist:
https://github.com/minimistjs/minimist
$ node example/parse.js -x 3 -y 4 -n5 -abc --beep=boop foo bar baz
{
	_: ['foo', 'bar', 'baz'],
	x: 3,
	y: 4,
	n: 5,
	a: true,
	b: true,
	c: true,
	beep: 'boop'
}
*/

// Simple cli for manual stuff

const main = async () => {

  var ship = { symbol: process.env.ACTIVE_SHIP };

  const cmd = argv['_'][0];
  switch (cmd) {
    case 'ship':
      console.log(await get('/my/ships/' + ship.symbol));
      break;

    case 'navigate':
      console.log('Navigating', ship.symbol, 'to', argv['_'][1]);
      await navigate(ship, argv['_'][1], 'manual navigation');
      break;

    case 'jump':
      console.log('Jumping', ship.symbol, 'to', argv['_'][1]);
      console.log(await post('/my/ships/' + ship.symbol + '/jump', {
        systemSymbol: argv['_'][1],
      }));
      break;

    case 'waypoints':
      ship = await get('/my/ships/' + ship.symbol);
      console.log(await get(`/systems/${ship.nav.systemSymbol}/waypoints`));
      break;

    case 'systems':
      console.log(JSON.stringify(await get(`/systems`), null, 2));
      break;

    case 'cooldown':
      const cooldown = await get(`/my/ships/${ship.symbol}/cooldown`);
      if (cooldown) {
        console.log(cooldown.remainingSeconds, 'remaining');
      } else {
        console.log('Ship is ready.')
      }
      break;

    default:
      break;
  }
  console.log('done.');
  process.exit(0);
}
main();