require('dotenv').config();
const { getSystemJumpGateWaypointSymbol } = require('../utils/utils');
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

const getGoodSystems = async (shipSymbol) => {
  const ship = await get(`/my/ships/${shipSymbol}`);
  const { systemSymbol } = ship.nav;

  // Get the systems within one jump
  const systemsWithinOneJump = await getSystemsWithinOneJump(systemSymbol);

  // Which ones have the traits we want?
  var goodSystemsData = await systemsWithinOneJump.reduce(async (systemDataPromise, oneSystemSymbol) => {
    const allSystemData = await systemDataPromise;
    const systemResult = await doesSystemHaveTraits(oneSystemSymbol);
    if (systemResult) {
      allSystemData[oneSystemSymbol] = systemResult;
    }
    return allSystemData;
  }, Promise.resolve([]));

  if (goodSystemsData.length > 0) {
    return goodSystemsData;
  }

  // If there are none within one jump, go another iteration
  const systemsWithinTwoJumps = await systemsWithinOneJump.reduce(async (systemSymbolListPromise, oneSystemSymbol) => {
    const systemSymbolList = await systemSymbolListPromise;
    // Get the systems within one jump
    const systemsWithinOneMoreJump = await getSystemsWithinOneJump(oneSystemSymbol);
    const unrepeatedSystems = systemsWithinOneMoreJump.filter((oneSymbol) =>
      !systemSymbolList.includes(oneSymbol) &&
      !systemsWithinOneJump.includes(oneSymbol)
    );
    if (unrepeatedSystems.length > 0) {
      // TODO Better data here to track the jump path
      systemSymbolList.push({
        jumpPath: [oneSystemSymbol],
        targetSystems: unrepeatedSystems,
      });
    }
    return systemSymbolList;
  }, Promise.resolve([]));

  // See which of these meet our criteria
  const goodSystemsWithinTwoJumps = await systemsWithinTwoJumps.reduce(async (systemDataPromise, { jumpPath, targetSystems }) => {
    const allSystemData = await systemDataPromise;
    const goodTargetSystems = await targetSystems.reduce(async (targetPromise, targetSystemSymbol) => {
      const prevTargets = await targetPromise;
      const systemResult = await doesSystemHaveTraits(targetSystemSymbol);
      if (systemResult) {
        prevTargets.push({
          jumpPath,
          symbol: targetSystemSymbol,
          traits: systemResult,
        });
      }
      return prevTargets;
    }, Promise.resolve([]));
    if (goodTargetSystems.length > 0) {
      allSystemData.push(...goodTargetSystems);
    }
    return allSystemData;
  }, Promise.resolve([]));
  return goodSystemsWithinTwoJumps;
}

const getSystemsWithinOneJump = async (systemSymbol) => {
  const jumpgateSymbol = await getSystemJumpGateWaypointSymbol(systemSymbol);
  const { connectedSystems: systemsWithinOneJumpData } = await get(`/systems/${systemSymbol}/waypoints/${jumpgateSymbol}/jump-gate`);
 return systemsWithinOneJumpData.map(({ symbol }) => symbol);
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

getGoodSystems(process.env.ACTIVE_SHIP)
  .then((data) => console.log(JSON.stringify(data, null, 2)))
  .catch(console.error)
  .finally(endPool);

// test -- should return data
// doesSystemHaveTraits('X1-QF66')
//   .then(console.log)
//   .catch(console.error)
//   .finally(endPool);