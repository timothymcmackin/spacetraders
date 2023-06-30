require('dotenv').config();
const {
  navigate, getSystemFromWaypoint,
} = require('./utils/utils');
const {
  get,
} = require('./utils/api');
const {
  endPool,
  getOrders,
  getAllSystemsAndJumpGates,
  getShipsByOrders,
  singleQuery,
} = require('./utils/databaseUtils');
const { updateMarketplaceData } = require('./utils/marketplaceUtils');

// Satellites are super slow!

// [ { systemSymbol: "", waypointSymbols: [] }]
var unvisitedMarketWaypointSymbols = [];
var unvisitedSytemSymbolss = [];

const survey = async () => {
  const shipSymbols = await getShipsByOrders('survey');
  // Do we assume that all ships start in the same system?
  // Probably not, so I can use this later
  // So get the ships and the initial states

  const ships = await Promise.all(shipSymbols.map(async (oneSymbol) => get('/my/ships/' + oneSymbol)));
  const currentlyStaffedSystems = ships.reduce((prevSystems, oneShip) => {
    if (!prevSystems.includes(oneShip.nav.systemSymbol)) {
      prevSystems.push(oneShip.nav.systemSymbol);
    }
    return prevSystems;
  }, []);

  // Get all waypoints in the initial systems
  const allWaypointData = await currentlyStaffedSystems.reduce(async (waypointDataPromise, oneSystemSymbol) => {
    const waypointData = await waypointDataPromise;
    const oneSystemData = await get(`/systems/${oneSystemSymbol}/waypoints`);
    return waypointData.concat(oneSystemData);
  }, []);

  // [
  //   {
  //     systemSymbol: "X1-DD46",
  //     jumpgateWaypoint: "X1-DD46-05015B",
  //   },
  //   {
  //     systemSymbol: "X1-YU85",
  //     jumpgateWaypoint: "X1-DD46-05015B",
  //   },
  // ]
  const systemsAndJumpgates = currentlyStaffedSystems.map((oneSystemSymbol) => {
    const jumpGateWaypoint = allWaypointData.find(({ type }) => type === 'JUMP_GATE');
    return {
      systemSymbol: oneSystemSymbol,
      jumpgateWaypoint: jumpGateWaypoint.symbol,
    }
  });

  // Update database with initial info about systems
  await systemsAndJumpgates.reduce(async (prevPromise, { systemSymbol, jumpgateWaypoint }) => {
    await prevPromise;
    const updateString = `REPLACE INTO systems (systemSymbol, jumpgateWaypoint)
      VALUES ("${systemSymbol}", "${jumpgateWaypoint}")`;
    await singleQuery(updateString);
  }, Promise.resolve());

  // Update database with initial info about waypoints
  await allWaypointData.reduce(async (prevPromise, waypoint) => {
    await prevPromise;
    const hasMarketplace = waypoint.traits.some(({ symbol }) => symbol === 'MARKETPLACE');
    const { systemSymbol, symbol } = waypoint;
    await singleQuery(`REPLACE INTO waypoints (systemSymbol, waypointSymbol, marketplace)
      VALUES ("${systemSymbol}", "${symbol}", ${hasMarketplace})`);
  }, Promise.resolve());

  //  Get marketplace data for the staffed waypoints with marketplaces
  const waypointsWeCanCheck = allWaypointData.filter(({ traits }) =>
    traits.some(({ symbol }) => symbol === 'MARKETPLACE')
  )
    .filter(({ symbol }) => ships.some(({ nav }) => nav.waypointSymbol === symbol));

  // Get market data for those waypoints we can check
  if (waypointsWeCanCheck.length > 0) {
    await waypointsWeCanCheck.reduce(async (prevPromise, { symbol, systemSymbol }) => {
      await prevPromise;
      const { tradeGoods } = await get(`/systems/${systemSymbol}/waypoints/${symbol}/market`);
      await updateMarketplaceData(systemSymbol, symbol, tradeGoods);
    }, Promise.resolve());
  }

  // Add the remaining waypoints to the list to check;
  unvisitedMarketWaypointSymbols = allWaypointData.filter(({ traits }) =>
    traits.some(({ symbol }) => symbol === 'MARKETPLACE')
  )
    .filter(({ symbol }) => !waypointsWeCanCheck.some(({symbol: checkSymbol}) => symbol === checkSymbol))
    .map(({ symbol }) => symbol);



  console.log(unvisitedMarketWaypointSymbols);

  // Now the hard part: send each ship off to check out the markets and see what systems they can jump to

}

survey()
  .then(endPool);
