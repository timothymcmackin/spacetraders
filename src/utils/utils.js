require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  fetchConnectionFromPool,
} = require('./databaseUtils');

const { post, get } = require('./api');

const { updateMarketplaceData } = require('./marketplaceUtils');
const { getPathToSystem } = require('./pathingUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const cacheFolder = path.resolve(__dirname, 'cache');
const contractCacheFileName = path.resolve(cacheFolder, 'contract.json');

const getSystemFromWaypoint = (waypointSymbol) => {
  const stringSplit = waypointSymbol.split('-');
  return `${stringSplit[0]}-${stringSplit[1]}`;
}

// Currently everything is one jump away
const jump = async (ship, systemSymbol) => {
  await post(`/my/ships/${ship.symbol}/orbit`);
  ship = await get('/my/ships/' + ship.symbol);
  if (ship.nav.systemSymbol === systemSymbol) {
    console.log('Already in system', systemSymbol);
    return;
  }

  const waypointsInSystem = await get(`/systems/${ship.nav.systemSymbol}/waypoints`);
  const jumpGateWaypoint = waypointsInSystem
    .find(({ type }) => type === 'JUMP_GATE');
  const targetWaypoint = jumpGateWaypoint.symbol;
  await navigate(ship, targetWaypoint, 'to jump gate', false);

  // Get the path of systems to jump to
  var pathOfJumps = await getPathToSystem(ship.nav.systemSymbol, systemSymbol);
  // Remove current location
  pathOfJumps.shift();

  // Jump loop
  await pathOfJumps.reduce(async (prevPromise, targetSystem) => {
    await prevPromise;

    console.log(ship.symbol, 'jumping to', targetSystem);
    await post(`/my/ships/${ship.symbol}/orbit`);
    const { nav } = await post('/my/ships/' + ship.symbol + '/jump', {
      targetSystem,
    });

    const departureTime = Date.parse(nav.route.departureTime);
    const arrivalTime = Date.parse(nav.route.arrival);

    // How long will it take?
    const waitTime = Math.ceil((arrivalTime - departureTime) / 1000 + 1);
    console.log(ship.symbol, 'travel time', waitTime, 'seconds');
    await timer(waitTime);
    console.log(ship.symbol, 'arrived after jump');

  }, Promise.resolve());

}

// Send the ship somewhere and resolve when it arrives
const navigate = async (ship, waypoint, reason = '', refuel = true) => {
  console.log(ship.symbol, 'navigating to', waypoint, reason);
  // Make sure we're in orbit
  var { nav } = await post(`/my/ships/${ship.symbol}/orbit`);

  // Are we in the right system?
  const targetSystem = getSystemFromWaypoint(waypoint);
  if (targetSystem !== nav.systemSymbol) {
    await jump(ship, targetSystem)
      .catch(err => {
        console.error('Jump pathing failed.');
        console.error(err);
      });
  }

  // Are we already there?
  if (waypoint === nav.waypointSymbol) {
    console.log(ship.symbol, 'is already at', waypoint);
    return;
  }

  var departureTime = 0;
  var arrivalTime = 0;
  await post(`/my/ships/${ship.symbol}/navigate`, {
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
      console.log(ship.symbol, 'travel time', waitTime, 'seconds');
      await timer(waitTime);
      console.log(ship.symbol, 'arrived');
    });

  // dock
  await post(`/my/ships/${ship.symbol}/dock`);
  //refuel
  // If we're at a jump gate, no fuel
  ship = await get('/my/ships/' + ship.symbol);
  const { type } = await get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}`);
  if (refuel && type !== 'JUMP_GATE') {
    const { transaction } = await post(`/my/ships/${ship.symbol}/refuel`);
    console.log(ship.symbol, 'fuel cost', transaction.totalPrice);
  }

  // Should be passing the system symbol to this function as well.
  // Till then:
  nav = (await get(`/my/ships/${ship.symbol}`)).nav;
  const { systemSymbol } = nav;

  // Does the waypoint have a market?
  const { traits } = await get(`/systems/${systemSymbol}/waypoints/${waypoint}`);
  if (traits.some(({ symbol }) => symbol === 'MARKETPLACE')) {
    const { tradeGoods } = await get(`/systems/${systemSymbol}/waypoints/${waypoint}/market`);
    // Maybe don't bother awaiting here and just let the promise run?
    await updateMarketplaceData(systemSymbol, waypoint, tradeGoods);
  }
}

// Assume we're at a marketplace
// Be sure to check that they have a market for the good
const sellAll = async (shipSymbol, dumpUnsold = false) => {
  const { nav, cargo } = await get(`/my/ships/${shipSymbol}`);
  const { systemSymbol, waypointSymbol } = nav;
  const { inventory } = cargo;
  if (inventory.length === 0) {
    console.log(shipSymbol, "doesn't have anything to sell");
    return;
  }

  // Get the marketplace data
  const marketplaceData = await get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
  const { tradeGoods } = marketplaceData;
  const thingsWeCanSellHere = tradeGoods.map(({ symbol }) => symbol);

  var totalSalePrice = 0;
  if (inventory.some(({ units }) => units > 0)) {
    // Sell everything
    // One good at a time due to limitations in the API
    await inventory.reduce(async (prevPromise, { symbol: materialSymbol, units }) => {
      await prevPromise;
      // Can we sell this here?
      if (thingsWeCanSellHere.includes(materialSymbol)) {
        // limit by tradeVolume
        var unitsToSell = units;
        const tradeVolume = tradeGoods.find(({ symbol }) => symbol == materialSymbol).tradeVolume;
        while (unitsToSell > 0) {
          const unitsToSellThisTime = Math.min(unitsToSell, tradeVolume);
          const { transaction } = await post(`/my/ships/${shipSymbol}/sell`, {
            symbol: materialSymbol,
            units: unitsToSellThisTime,
          });
          totalSalePrice += transaction.totalPrice;
          unitsToSell -= unitsToSellThisTime;
        }
      } else {
        // Can't sell here, so dump it
        if (dumpUnsold) {
          return post(`/my/ships/${shipSymbol}/jettison`, {
            symbol: materialSymbol,
            units,
          });
        }
      }
    }, Promise.resolve());
    console.log(shipSymbol, 'sold cargo');
  }
  return totalSalePrice;
}

const travelToNearestMarketplace = async (shipSymbol) => {
  const ship = await get(`/my/ships/${shipSymbol}`);
  const waypointsInSystem = await get(`/systems/${ship.nav.systemSymbol}/waypoints`);
  const waypointsWithMarketplaces = waypointsInSystem
    .filter(({ traits }) =>
      traits.some(({ symbol }) => symbol === 'MARKETPLACE')
    )
    .map(({ symbol }) => symbol);

  // Are we already there?
  if (waypointsInSystem.some(({ symbol }) => symbol === ship.nav.waypointSymbol)) {
    return;
  }

  // TODO Figure out which one to go to
  // For now, pick one at random
  const targetWaypoint = waypointsWithMarketplaces[Math.floor(Math.random() * waypointsWithMarketplaces.length)];

  await post(`/my/ships/${shipSymbol}/orbit`);
  await navigate(ship, targetWaypoint, 'nearest marketplace');
}

module.exports = {
  contractCacheFileName,
  navigate,
  sellAll,
  travelToNearestMarketplace,
  getSystemFromWaypoint,
}