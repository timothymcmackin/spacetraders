require('dotenv').config();
const fs = require('fs');
const {
  log,
  post,
  get,
  timer,
  contractCacheFileName,
  navigate,
  sellAll,
  travelToNearestMarketplace,
} = require('./utils');
const {
  getAvailableMiningShips,
  controlShip,
  updateShipIsActive,
  releaseShip,
  restartInactiveShips,
  endPool,
  initDatabase,
} = require('./databaseUtils');
const { updateMarketplaceData } = require('./marketplaceUtils');

// Get a new account started because I messed up the last one
// const init = async () => {
//   await initDatabase(); // done
// }

// Get initial price info for the system
const surveySystem = async () => {
  const ships = await get('/my/ships');
  const ship = ships[0];
  const { systemSymbol, waypointSymbol } = ship.nav;
  const waypointData = await get(`/systems/${systemSymbol}/waypoints`);
  const waypointsWithMarkets = waypointData.filter(({ traits }) =>
    traits.some(({ symbol }) => symbol === 'MARKETPLACE')
  );
  // Is there a market here?
  if (waypointsWithMarkets.some(({ symbol }) => symbol === waypointSymbol)) {
    const { tradeGoods } = await get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
    await updateMarketplaceData(systemSymbol, waypointSymbol, tradeGoods);
  }

  var waypointsToVisit = waypointsWithMarkets.filter(({ symbol }) => symbol !== waypointSymbol);

  for (const i in waypointsToVisit) {
    if (Object.hasOwnProperty.call(waypointsToVisit, i)) {
      const waypointToVisit = waypointsToVisit[i];
      await navigate(ship, waypointToVisit.symbol, 'to survey');
    }
  }

}

surveySystem();