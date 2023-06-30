require('dotenv').config();
const {
  navigate,
  getSystemFromWaypoint,
  sellAll,
} = require('./utils');
const {
  post,
  get,
} = require('./api');
const { endPool } = require('./databaseUtils');
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
      console.log(JSON.stringify((await get('/my/ships/' + ship.symbol)), null, 2));
      break;

    case 'navigate':
      console.log('Navigating', ship.symbol, 'to', argv['_'][1]);
      await navigate(ship, argv['_'][1], 'manual navigation');
      break;

    case 'agent':
      console.log(await get('/my/agent'));
      break;

    case 'dock':
      await post('/my/ships/' + ship.symbol + '/dock');
      break;

    case 'orbit':
      await post('/my/ships/' + ship.symbol + '/orbit');
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

    case 'waypoint':
      waypoint = await get(`/systems/${getSystemFromWaypoint(argv['_'][1])}/waypoints/${argv['_'][1]}`);
      console.log(JSON.stringify(waypoint, null, 2));
      break;

    case 'marketplace':
      waypoint = await get(`/systems/${getSystemFromWaypoint(argv['_'][1])}/waypoints/${argv['_'][1]}/market`);
      console.log(JSON.stringify(waypoint, null, 2));
      break;

    case 'sellAll':
      await sellAll(ship.symbol);
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
      console.error("Didn't recognize that command.");
      break;
  }
  console.log('done.');
  endPool();
  process.exit(0);
}
main();