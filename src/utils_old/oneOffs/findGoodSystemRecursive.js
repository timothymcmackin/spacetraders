require('dotenv').config();
const {
  getSystemJumpGateWaypointSymbol,
  getSystemFromWaypoint,
} = require('../utils/utils');
const {
  post,
  get,
} = require('../utils/api');
const { endPool } = require('../utils/databaseUtils');

// Find a system with waypoints with these traits:
// - SHIPYARD
// - MARKETPLACE
// - ASTEROID_FIELD
// - shipyard sells mining ships

const getGoodSystemsWithRecursion = async (shipSymbol) => {
  const ship = await get(`/my/ships/${shipSymbol}`);
  const { systemSymbol } = ship.nav;
  return getGoodSystemsRecursive(systemSymbol);
}

// Avoid getting the same system twice
var checkedSystems = [];
const getGoodSystemsRecursive = async (systemSymbol, path = [], level = 1) => {
  if (level > 5) {
    return;
  }

  // Get the systems within one jump that we haven't checked yet
  const systemsWithinOneJump = (await getSystemsWithinOneJump(systemSymbol))
    .filter((oneSystem) => !checkedSystems.includes(oneSystem));
  checkedSystems.push(...systemsWithinOneJump);

  // Are any of these systems good?
  const goodSystems = await Promise.all(systemsWithinOneJump.map(doesSystemHaveTraits));
  var systemsToReturn = goodSystems.filter((s) => !!s);

  // Do any of these systems have targets that are good?
  const goodSystemsRecursed = await Promise.all(systemsWithinOneJump.map((recurseSymbol) =>
    getGoodSystemsRecursive(recurseSymbol, path.concat(systemSymbol), level + 1)
  ));
  const goodSystemsRecursedToAdd = goodSystemsRecursed.filter((s) => !!s && s.length > 0);
  if (goodSystemsRecursedToAdd && goodSystemsRecursedToAdd.length) {
    for (const results in goodSystemsRecursedToAdd) {
      if (Object.hasOwnProperty.call(goodSystemsRecursedToAdd, results)) {
        const oneSystem = goodSystemsRecursedToAdd[results];
        systemsToReturn.push(oneSystem);
      }
    }
  }
  return systemsToReturn;
}

const getSystemsWithinOneJump = async (systemSymbol) => {
  const jumpgateSymbol = await getSystemJumpGateWaypointSymbol(systemSymbol);
  const { connectedSystems: systemsWithinOneJumpData } = (await get(`/systems/${systemSymbol}/waypoints/${jumpgateSymbol}/jump-gate`));
  const systemsWithinOneJumpSymbols = systemsWithinOneJumpData.map(({ symbol }) => symbol);
  const systemsWithJumpGate = (await Promise.all(systemsWithinOneJumpSymbols.map(getSystemJumpGateWaypointSymbol)))
    .filter((s) => !!s);
  return systemsWithJumpGate.map(getSystemFromWaypoint);
}

const doesSystemHaveTraits = async (systemSymbol) => {
  const thisSystemWaypoints = await get(`/systems/${systemSymbol}/waypoints`);
  var availableShips = [];
  const marketplaceWaypointData = thisSystemWaypoints.find(({ traits }) =>
    traits.some(({ symbol }) => symbol === 'MARKETPLACE')
  );
  const shipyardWaypointData = thisSystemWaypoints.find(({ traits }) =>
    traits.some(({ symbol }) => symbol === 'SHIPYARD')
  );
  if (shipyardWaypointData) {
    const shipyardWaypointSymbol = shipyardWaypointData.symbol;
    const shipyardQuery = `/systems/${systemSymbol}/waypoints/${shipyardWaypointSymbol}/shipyard`;
    const { shipTypes } = await get(shipyardQuery);
    availableShips = shipTypes.map(({ type }) => type);
  }
  const asteroidWaypointData = thisSystemWaypoints.find(({ type }) =>
    type === 'ASTEROID_FIELD'
  );
  if (marketplaceWaypointData && shipyardWaypointData && asteroidWaypointData && availableShips.includes('SHIP_MINING_DRONE')) {
    return {
      MARKETPLACE: marketplaceWaypointData,
      SHIPYARD: shipyardWaypointData,
      ASTEROID_FIELD: asteroidWaypointData,
      availableShips,
    };
  }
}

getGoodSystemsWithRecursion(process.env.ACTIVE_SHIP)
  .then((data) => console.log(JSON.stringify(data, null, 2)))
  .catch(console.error)
  .finally(endPool);
