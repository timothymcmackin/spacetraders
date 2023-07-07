require('dotenv').config();
const fs = require('fs');
const {
  navigate,
} = require('./utils/utils');
const { get, post } = require('./api');
const {
} = require('./databaseUtils');
const { updateMarketplaceData } = require('./utils/marketplaceUtils');

// Get a new account started because I messed up the last one
// const init = async () => {
//   await initDatabase(); // done
// }

// Get initial price info for the system
const surveySystem = async () => {
  const ship = await get('/my/ships/' + process.env.ACTIVE_SHIP);
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
  console.log('Done surveying.');

}
