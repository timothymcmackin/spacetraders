require('dotenv').config();
const {
  getSystemFromWaypoint,
  sellAll,
  survey,
  extract,
  extractUntilFull,
} = require('./utils');
const api = require('./api');
const { navigate } = require('./navigationUtils');
const argv = require('minimist')(process.argv.slice(2));

const timer = s => new Promise( res => setTimeout(res, s * 1000));

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
      console.log(JSON.stringify((await api.ship(ship.symbol)), null, 2));
      break;
    case 'ships':
      console.log(JSON.stringify((await api.ships()), null, 2));
      break;

    case 'navigate':
      console.log('Navigating', ship.symbol, 'to', argv['_'][1]);
      await navigate(ship.symbol, argv['_'][1], 'manual navigation');
      break;

    case 'agent':
      console.log(await api.agent());
      break;

    case 'dock':
      await api.dock(ship.symbol);
      break;

    case 'refuel':
      await api.refuel(ship.symbol);
      break;

    case 'orbit':
      await api.orbit(ship.symbol);
      break;

    case 'jump':
      console.log('Jumping', ship.symbol, 'to', argv['_'][1]);
      const { cooldown } = await post('/my/ships/' + ship.symbol + '/jump', {
        systemSymbol: argv['_'][1],
      });
      await timer(cooldown.remainingSeconds + 1);
      break;

    case 'waypoints':
      ship = await api.ship(ship.symbol);
      console.log(JSON.stringify(await api.waypoints(ship.nav.systemSymbol), null, 2));
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

    case 'survey':
      console.log('Surveying.');
      await survey(ship.symbol);
      break;

    case 'extract':
      console.log('extracting')
      await extract(ship.symbol);
      break;

    case 'extractUntilFull':
      console.log('extracting until full')
      await extractUntilFull(ship.symbol);
      break;

    case 'updateShipTable':
      console.log('Updating ships table');
      await updateShipTable();
      break;

    case 'cooldown':
      const currentCooldown = await api.cooldown(ship.symbol);
      if (currentCooldown) {
        console.log(currentCooldown.remainingSeconds, 'remaining');
      } else {
        console.log('Ship is ready.')
      }
      break;

    default:
      console.error("Didn't recognize that command.");
      break;
  }
  console.log('done.');
  process.exit(0);
}
main();