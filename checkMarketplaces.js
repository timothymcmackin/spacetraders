require('dotenv').config();
const { updateMarketplaceData, endPool } = require('./databaseUtils');
const {
  post,
  get,
} = require('./utils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const getWaypointPrices = async () => {
  // const waypointsInSystem = await get('/systems/X1-YU85/waypoints');
  // const waypointsWithMarketplaces = waypointsInSystem
  //   .filter(({ traits }) =>
  //     traits.some(({ symbol }) => symbol === 'MARKETPLACE')
  //   )
  //   .map(({ symbol }) => symbol);
  // console.log(waypointsWithMarketplaces);
  /*
  [
    'X1-YU85-99640B',
    'X1-YU85-03282C',
    'X1-YU85-87273F',
    'X1-YU85-81074E',
    'X1-YU85-76885D',
    'X1-YU85-34607X',
    'X1-YU85-25998Z',
  ]
  */

}

const updateWaypointPrices = async (systemSymbol, waypointSymbol) => {
  // Does the waypoint have a market?
  const { traits } = await get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}`);
  if (traits.some(({ symbol }) => symbol === 'MARKETPLACE')) {
    const { tradeGoods } = await get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
    await updateMarketplaceData(systemSymbol, waypointSymbol, tradeGoods);
  }
  endPool();
}

// get('/my/ships/PINCKNEY-1')
//   .then((ship) =>
//     updateWaypointPrices(ship.nav.systemSymbol, ship.nav.waypointSymbol)
//   );