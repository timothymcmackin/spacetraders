require('dotenv').config();
const {
  navigate, getSystemFromWaypoint,
} = require('./utils/utils');
const {
  get, post,
} = require('./utils/api');
const {
  endPool,
  singleQuery,
  initDatabase,
} = require('./utils/databaseUtils');
const { updateMarketplaceData } = require('./utils/marketplaceUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

// Globals!
// [ { systemSymbol: "", waypointSymbols: [] }]
var unvisitedMarketWaypointSymbols = [];
var unvisitedJumpgateWaypointSymbols = [];
var unvisitedSytemsAndJumpgates = [];
var shipsInTransit = [];
var idleShips = [];
var indexedSystems;
const indexedSystemsLimit = 5; // Limit the number of systems to deal with for now

const survey = async () => {

  // Do we assume that all of my ships start in the same system?
  // Probably not, so I can use this later
  // So get the ships and the initial states

  const ships = (await get('/my/ships'))
  // Satellites are super slow!
    .filter(({ symbol }) => symbol === process.env.SPACETRADERS_PREFIX + '-1');

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
  indexedSystems = systemsAndJumpgates.map(({ systemSymbol }) => systemSymbol);

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
  idleShips = ships.map(({ symbol }) => symbol);
  // How the hell?

  // Globals we're using in case we need to refer to them in another function:
  /*
  var unvisitedMarketWaypointSymbols = [];
  var unvisitedJumpgateWaypointSymbols = [];
  var unvisitedSytemsAndJumpgates = [];
  var shipsInTransit = [];
  var idleShips = [];
  */
  var keepGoing = true;
  while (keepGoing) {

    // Send inactive ships to an unvisited market waypoint
    while (idleShips.length > 0 && unvisitedMarketWaypointSymbols.length > 0) {
      // Get an idle ship to send
      const shipToSend = idleShips.shift();
      shipsInTransit.push(shipToSend);
      // Where is the ship now?
      const ship = await get(`/my/ships/${shipToSend}`);
      const currentSystem = ship.nav.systemSymbol;
      // Get an unvisited waypoint to visit
      // Could make this better by getting the nearest unvisited waypoint
      // First, check the same system
      var marketWaypointToGoTo = unvisitedMarketWaypointSymbols.find((waypointSymbol) =>
        getSystemFromWaypoint(waypointSymbol) === currentSystem
      );
      // If there are no unvisited waypoints in the system, go to another system
      marketWaypointToGoTo = marketWaypointToGoTo || unvisitedMarketWaypointSymbols.shift();
      // Remove the system
      unvisitedMarketWaypointSymbols = unvisitedMarketWaypointSymbols.filter((s) => s !== marketWaypointToGoTo);
      // Send the ship there but don't await the promise so we can send other ships
      sendShip(shipToSend, marketWaypointToGoTo)
        .then(({ arrivedShip }) => {
          // Mark ship as available
          // Hopefully this isn't a race condition that will mess up the idleShips and shipsInTransit arrays
          shipsInTransit = shipsInTransit.filter(( oneShip ) => oneShip !== arrivedShip);
          idleShips.push(arrivedShip);
      });
    }

    // There are no unvisited waypoints, so visit a jump gate and see where we can go from there
    // Lots of this would be unnecessary if we indexed systems when we reached a jump gate
    // But this covers the initial case of a single system with no other known systems to go to
    // (until we visit the first jump gate)
    while (idleShips.length > 0 && unvisitedJumpgateWaypointSymbols.length > 0) {
      // Get an idle ship to send
      const shipToSend = idleShips.shift();
      shipsInTransit.push(shipToSend);
      // Where is the ship now?
      const ship = await get(`/my/ships/${shipToSend}`);
      const currentSystem = ship.nav.systemSymbol;
      // Get an unvisited jump gate waypoint to visit
      // First, check the same system
      var jumpgateWaypointToGoTo = unvisitedJumpgateWaypointSymbols.find((waypointSymbol) =>
        getSystemFromWaypoint(waypointSymbol) === currentSystem
      );
      // If there are no unvisited waypoints in the system, go to another system
      jumpgateWaypointToGoTo = jumpgateWaypointToGoTo || unvisitedJumpgateWaypointSymbols.shift();
      // Remove the system
      unvisitedJumpgateWaypointSymbols = unvisitedJumpgateWaypointSymbols.filter((s) => s !== jumpgateWaypointToGoTo);
      // Send the ship there but don't await the promise so we can send other ships
      sendShip(shipToSend, jumpgateWaypointToGoTo)
        .then(async ({ arrivedShip, arrivedWaypoint }) => {
          // Get the systems and waypoints we can go to from this jump gate
          const { connectedSystems } = await get(`/systems/${getSystemFromWaypoint(arrivedWaypoint)}/waypoints/${arrivedWaypoint}/jump-gate`);
          // [{ systemSymbol, jumpgateWaypoint }]
          const waypointsAndJumpGates = (await Promise.all(connectedSystems.map(async (oneSystem) => {
            // Get the waypoints in this system
            const waypointsInOneSystem = await get(`/systems/${oneSystem.symbol}/waypoints`);
            // If there's a jump gate, we can get to it, so add it to the list
            const waypointWithJumpgate = waypointsInOneSystem.find(({ type }) => type === 'JUMP_GATE');
            return {
              systemSymbol: oneSystem.symbol,
              jumpgateWaypoint: waypointWithJumpgate?.symbol,
            };
          })))
            .filter(({ jumpgateWaypoint }) => !!jumpgateWaypoint);
          // Add the jump gate waypoints and systems to the list
          // Limit by the max systems to index
          while (
            waypointsAndJumpGates.length > 0 &&
            indexedSystems.length <= indexedSystemsLimit
          ) {
            const onePotentialNewSystem = waypointsAndJumpGates.pop();
            if (
              // If the system is not already indexed
              !indexedSystems.some((systemId) => systemId === onePotentialNewSystem.systemSymbol) &&
              // If the system is not already scheduled to be indexed
              !unvisitedSytemsAndJumpgates.some(({ systemSymbol }) === onePotentialNewSystem.systemSymbol)
            ) {
              unvisitedSytemsAndJumpgates.push(onePotentialNewSystem);
              // Add as a waypoint to go to
              // It doesn't have a market, but that should be OK
              unvisitedMarketWaypointSymbols.push(onePotentialNewSystem.waypointSymbol);
            }
          }
          // Mark ship as available
          // Hopefully this isn't a race condition that will mess up the idleShips and shipsInTransit arrays
          shipsInTransit = shipsInTransit.filter(( oneShip ) => oneShip !== arrivedShip);
          idleShips.push(arrivedShip);
      });

    }

    // If there are no unvisited waypoints, go to a new system
    // This should be automatic because we added the waypoint on the other end of the jump gate to go to

    // If there are ships in transit but nowhere for the idle ships to go, wait a few secs and try again
    await timer(10);

    // While there are unvisited waypoints, unvisited systems, unvisited jump gates, or ships in transit
    keepGoing =
      shipsInTransit.length > 0 ||
      unvisitedMarketWaypointSymbols.length > 0 ||
      unvisitedJumpgateWaypointSymbols.length > 0 ||
      unvisitedSytemsAndJumpgates.length > 0;
  }

}

// Send a ship somewhere and return its info when it's there
// Market indexing happens automatically as part of the navigate() function
const sendShip = async (shipToSend, waypointToGoTo) => {
  await navigate({ symbol: shipToSend }, waypointToGoTo, 'for surveying');
  return {
    arrivedShip: shipToSend,
    arrivedWaypoint: waypointToGoTo,
  };
}

// Everyone starts in the same system, so take some random jumps to get away from heavily-used markets
const randomJumps = async (shipSymbol, numberOfJumps) => {
  const ship = await get(`/my/ships/${shipSymbol}`);
  var currentSystem = ship.nav.systemSymbol;
  var visitedSystems = [currentSystem];
  // Are we at a jump gate?
  const waypoints = await get(`/systems/${currentSystem}/waypoints`);
  const jumpgateWaypoint = waypoints.find(({ type }) => type === 'JUMP_GATE');
  if (ship.nav.waypointSymbol !== jumpgateWaypoint) {
    await navigate(shipSymbol, jumpgateWaypoint, 'to jump gate before random jumps');
  }
  for (let i = 0; i < numberOfJumps; i++) {
    const { connectedSystems } = await get(`/systems/${currentSystem}/waypoints/${jumpgateWaypoint}/jump-gate`);
    const potentialNextSystems = connectedSystems.filter(({ symbol }) => !visitedSystems.includes(symbol));
    // But which ones have jump gates?
    const potentialNextWaypoints = await potentialNextSystems.reduce(async (prevWaypointsPromise, { symbol: systemSymbol }) => {
      const prevWaypoints = await prevWaypointsPromise;
      const waypointsInTargetSystem = await get(`/systems/${systemSymbol}/waypoints`);
      const potentialJumpgateWaypoint = waypointsInTargetSystem.find(({ type }) => type === 'JUMP_GATE');
      if (potentialJumpgateWaypoint) {
        prevWaypoints.push(potentialJumpgateWaypoint);
      }
      return prevWaypoints;
    }, Promise.resolve([]));
    // Was it a dead end? If so, go back a waypoint
    var nextWaypoint;
    if (potentialNextWaypoints.length > 0) {
      nextWaypoint = potentialNextWaypoints[Math.floor(Math.random() * potentialNextWaypoints.length)];
    } else {
      nextWaypoint = visitedSystems[visitedSystems.length - 1];
    }
    visitedSystems.push(getSystemFromWaypoint(nextWaypoint));
    const { cooldown } = await post(`/my/ships/${shipSymbol}/jump`, {
      systemSymbol: getSystemFromWaypoint(nextWaypoint),
    });
    await timer(cooldown + 1);
  }
}

initDatabase()
  .then(randomJumps)
  .then(survey)
  .then(endPool);
