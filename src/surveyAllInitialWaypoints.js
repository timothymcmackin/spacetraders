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

const timer = s => new Promise( res => setTimeout(res, s * 1000));

// Satellites are super slow!

// Globals!
// [ { systemSymbol: "", waypointSymbols: [] }]
var unvisitedMarketWaypointSymbols = [];
var unvisitedJumpgateWaypointSymbols = [];
var unvisitedSytemSymbols = [];
var shipsInTravel = [];
var inactiveShips = [];

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
    const jumpgateWaypoint = allWaypointData.find(({ type }) => type === 'JUMP_GATE');
    return {
      systemSymbol: oneSystemSymbol,
      jumpgateWaypoint: jumpgateWaypoint.symbol,
    }
  });

  // Update database with initial info about systems
  await systemsAndJumpgates.reduce(async (prevPromise, { systemSymbol, jumpgateWaypoint }) => {
    await prevPromise;
    const updateString = `REPLACE INTO systems (systemSymbol, jumpgateWaypoint)
      VALUES ("${systemSymbol}", "${jumpgateWaypoint}")`;
    await singleQuery(updateString);
  }, Promise.resolve());

  // Add the jump gates to check
  unvisitedJumpgateWaypointSymbols = systemsAndJumpgates.map(({ jumpgateWaypoint }) => jumpgateWaypoint);

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


  // Now the hard part: send each ship off to check out the markets and see what systems they can jump to
  inactiveShips = [...shipSymbols];
  // How the hell?

  // Globals we're using in case we need to refer to them in another function:
  /*
  var unvisitedMarketWaypointSymbols = [];
  var unvisitedJumpgateWaypointSymbols = [];
  var unvisitedSytemSymbols = [];
  var shipsInTravel;
  var inactiveShips;
  */
  var keepGoing = true;
  while (keepGoing) {
    // If there are no inactive ships there's nothing to do at this point
    if (inactiveShips.length > 0) {
      // Send inactive ships to an unvisited market waypoint
      while (inactiveShips.length > 0 && unvisitedMarketWaypointSymbols.length > 0) {
        // place


      }
      // If there are no unvisited waypoints, go to a new system
      // If there are no unvisited systems, go to a jump gate and see which systems we can go to, add them, and go to one
      // If there are ships in transit but nowhere for the idle ships to go, wait a few secs and try again

    } else {
      // no inactive ships
      await timer(5);
    }

  }
  // While there are unvisited waypoints, unvisited systems, unvisited jump gates, or ships in transit

}



survey()
  .then(endPool);
