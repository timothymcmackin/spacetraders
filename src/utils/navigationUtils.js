require('dotenv').config();
const api = require('./api');
const {
  getPathToSystem,
} = require('./pathingUtils');
const {
  getSystemFromWaypoint,
  getJumpgateWaypointSymbol,
  timer,
} = require('./utils')
const {
  updateMarketplaceData,
} = require('./marketplaceUtils');

// Send the ship somewhere and resolve when it arrives
const navigate = async (shipSymbol, waypoint, reason = '', refuel = true) => {
  console.log(shipSymbol, 'navigating to', waypoint, reason);
  // Make sure we're in orbit
  await api.orbit(shipSymbol);
  var { nav } = await api.ship(shipSymbol);
  // Are we in the right system?
  const targetSystem = getSystemFromWaypoint(waypoint);
  if (targetSystem !== nav.systemSymbol) {
    await jump(shipSymbol, targetSystem)
      .catch(err => {
        console.error('Jump pathing failed.');
        console.error(err);
      });
  }

  // Are we already there?
  if (waypoint === nav.waypointSymbol) {
    console.log(shipSymbol, 'is already at', waypoint);
    return;
  }

  var departureTime = 0;
  var arrivalTime = 0;
  await api.post(`/my/ships/${shipSymbol}/navigate`, {
    waypointSymbol: waypoint,
  })
    .then(async (navigationResponse) => {
      if (!navigationResponse) {
        return;
      }
      departureTime = Date.parse(navigationResponse.nav.route.departureTime);
      arrivalTime = Date.parse(navigationResponse.nav.route.arrival);

      // How long will it take?
      const waitTime = Math.ceil((arrivalTime - departureTime) / 1000 + 1);
      console.log(shipSymbol, 'travel time', waitTime, 'seconds');
      await timer(waitTime);
      console.log(shipSymbol, 'arrived');
    });

  // dock
  await api.dock(shipSymbol);
  //refuel
  // If we're at a jump gate, no fuel
  ship = await api.ship(shipSymbol);
  const { type } = await api.get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}`);
  if (refuel && type !== 'JUMP_GATE') {
    // Fuel not available everywhere
    try {
      const { transaction } = await api.refuel(shipSymbol);
      console.log(shipSymbol, 'fuel cost', transaction.totalPrice);
    } catch (error) {
      // It's all good
    }
  }

  // Should be passing the system symbol to this function as well.
  // Till then:
  nav = (await api.ship(shipSymbol)).nav;
  const { systemSymbol } = nav;

  // Does the waypoint have a market?
  const { traits } = await api.get(`/systems/${systemSymbol}/waypoints/${waypoint}`);
  if (traits.some(({ symbol }) => symbol === 'MARKETPLACE')) {
    const { tradeGoods } = await api.get(`/systems/${systemSymbol}/waypoints/${waypoint}/market`);
    // Maybe don't bother awaiting here and just let the promise run?
    await updateMarketplaceData(systemSymbol, waypoint, tradeGoods);
  }
}

// Jump ship to another system
// Capable of pathing over multiple systems
const jump = async (shipSymbol, targetSystemSymbol) => {
  await api.orbit(shipSymbol);
  const ship = await api.ship(shipSymbol);
  if (ship.nav.systemSymbol === targetSystemSymbol) {
    console.log('Already in system', targetSystemSymbol);
    return;
  }

  const jumpgateWaypoint = await getJumpgateWaypointSymbol(ship.nav.systemSymbol);
  await navigate(shipSymbol, jumpgateWaypoint, 'to jump gate', false);

  // Get the path of systems to jump to
  var pathOfJumps = await getPathToSystem(ship.nav.systemSymbol, targetSystemSymbol);
  // Remove current location
  pathOfJumps.shift();
  console.log('Jump path:', pathOfJumps);

  // Jump loop
  await pathOfJumps.reduce(async (prevPromise, targetSystem) => {
    await prevPromise;

    await api.orbit(shipSymbol);
    console.log(shipSymbol, 'jumping to', targetSystem);
    const { cooldown } = await api.post('/my/ships/' + shipSymbol + '/jump', {
      systemSymbol: targetSystem,
    });
    console.log(shipSymbol, 'travel time', cooldown.remainingSeconds, 'seconds');
    await timer(cooldown.remainingSeconds + 1);
    console.log(shipSymbol, 'arrived after jump');

  }, Promise.resolve());

}

module.exports = {
  navigate,
  jump,
}

// test jump and navigate
// navigate('KITE-1', 'X1-YU85-76885D', 'manual testing')
navigate('KITE-1', 'X1-FV50-32536D', 'manual testing');