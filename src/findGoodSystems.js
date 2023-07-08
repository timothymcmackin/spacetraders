require('dotenv').config();
const api = require('./utils/api');

const findGoodSystems = async (pool) => {
  let db;
  try {
    db = await pool.getConnection();

    // Get systems where we can mine and sell mined resources
    const allSystemSymbols = (await db.query(`SELECT systemSymbol FROM systems where jumpgateWaypoint IS NOT NULL`))
      .map(({ systemSymbol }) => systemSymbol);

    // Who's got asteroids and a shipyard that sells either SHIP_ORE_HOUND or SHIP_MINING_DRONE?
    const systemInfo = (await Promise.all(allSystemSymbols.map(async (systemSymbol) => {
      const asteroidFields = await db.query(`SELECT waypointSymbol FROM waypoints
        WHERE systemSymbol = "${systemSymbol}" AND type = "ASTEROID_FIELD"`);
      const marketplaces = await db.query(`SELECT waypointSymbol FROM waypoints
        WHERE systemSymbol = "${systemSymbol}" AND marketplace = 1`);
      // What ships can we buy in this system?
      const availableShips = (await db.query(`SELECT DISTINCT ss.shipType FROM shipyard_ships AS ss
        INNER JOIN waypoints AS w
        ON w.waypointSymbol = ss.waypointSymbol
        WHERE w.waypointSymbol LIKE "${systemSymbol}%"`))
        .map(({ shipType }) => shipType);
      return {
        systemSymbol,
        asteroidFields,
        marketplaces,
        availableShips,
      };
    })))

    const filteredSystemInfo = systemInfo
      .filter(({ asteroidFields, marketplaces, availableShips }) =>
        asteroidFields.length > 0 && marketplaces.length > 0 &&
        (availableShips.includes('SHIP_MINING_DRONE') || availableShips.includes('SHIP_ORE_HOUND'))
      );

    for (const oneSystemInfo in filteredSystemInfo) {
      if (Object.hasOwnProperty.call(filteredSystemInfo, oneSystemInfo)) {
        const {
          systemSymbol,
          asteroidFields,
          marketplaces,
          availableShips,
        } = filteredSystemInfo[oneSystemInfo];
        const shipsWeCareAbout = availableShips.filter(
          (shipType) => ['SHIP_ORE_HOUND', 'SHIP_MINING_DRONE'].includes(shipType)
        );
        console.log(`System ${systemSymbol} has ${asteroidFields.length} asteroid fields, ${marketplaces.length} marketplaces, and the ships ${shipsWeCareAbout.join(', ')}.`);
      }
    }

  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

module.exports = {
  findGoodSystems,
}
