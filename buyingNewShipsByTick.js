const fs = require('fs');
const {
  log,
  post,
  get,
  shipCacheFileName,
  navigate,
} = require('./utils');

const commandShipSymbol = 'PINCKNEY-1';

const main = async () => {

  // To conserve rate limit, cache ships and contracts
  var ships;
  try {
    ships = require(shipCacheFileName);
  } catch (error) {
    // Get ship status
    ships = await get('/my/ships');
    await fs.promises.writeFile(shipCacheFileName, JSON.stringify(ships, null, 2));
  }

  // Get the command ship
  const ship = await get('/my/ships/' + commandShipSymbol);
  const currentSystem = ship.nav.systemSymbol;
  const currentWaypoint = ship.nav.waypointSymbol;

  await post(`/my/ships/${ship.symbol}/orbit`);

  // Are we at a shipyard?
  var waypointWithShipyard = currentWaypoint;
  const { traits } = await get(`/systems/${currentSystem}/waypoints/${currentWaypoint}`);
  if (!traits.some(({ symbol }) => symbol === 'SHIPYARD')) {
    // Navigate to a shipyard
    const waypointsInSystem = await get(`/systems/${currentSystem}/waypoints`);
    const waypointWithShipyard = waypointsInSystem.find(({ traits }) => traits.some(( oneTrait ) => oneTrait.symbol === 'SHIPYARD'));
    await navigate(ship, waypointWithShipyard.symbol, 'to a shipyard');
  }
  await post(`/my/ships/${ship.symbol}/dock`);

  // Get mining drone cost
  const shipyardForSale = await get(`/systems/${currentSystem}/waypoints/${waypointWithShipyard}/shipyard`);
  // Assuming all shipyards sell mining drones
  const miningDroneForSale = shipyardForSale.ships.find(({ type }) => type === 'SHIP_MINING_DRONE');
  const price = miningDroneForSale.purchasePrice;

  // How many can we buy?
  const { credits } = await get('/my/agent');
  const numberOfDronesToBuy = Math.floor(credits / price);

  // Buy them all
  // Does the price change with demand?
  log('Buying', numberOfDronesToBuy, 'mining drones');
  for (let i = 0; i < numberOfDronesToBuy; i++) {
    await post('/my/ships', {
      shipType: 'SHIP_MINING_DRONE',
      waypointSymbol: waypointWithShipyard,
    });
  }

  // Update ships cache
  ships = await get('/my/ships');
  await fs.promises.writeFile(shipCacheFileName, JSON.stringify(ships, null, 2));

}

main()
  .catch(err => {
    console.error(err);
  });
