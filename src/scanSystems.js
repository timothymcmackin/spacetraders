require('dotenv').config();
const api = require('./utils/api');
const { getPool } = require('./utils/databaseUtils');
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const axiosRetry = require('axios-retry');

// Global
var scannedSystems = [];
const depthLimit = 15;
const pool = getPool();

// Because I'm having issues with errors from the jump-gate endpoint
const client = axios.create({
  baseURL: 'https://api.spacetraders.io/v2/',
  timeout: 50000,
  headers: { 'Authorization': `Bearer ${process.env.SPACETRADERS_TOKEN}` },
});
axiosRetry(client, { retries: 3 });

const localApi = rateLimit(client,
  // Limit to 1 request per second
  // https://github.com/aishek/axios-rate-limit
  { maxRPS: 1}
);

const scanSystems = async (initialSystemSymbol, pool) => {
  // Get data on inital system
  scannedSystems.push(initialSystemSymbol);
  await scanSystemRecursive(initialSystemSymbol, pool);
}

const scanSystemRecursive = async (systemSymbol, pool, depth = 0) => {
  const systemWaypoints = await api.get(`/systems/${systemSymbol}/waypoints`);
  const jumpgateWaypoint = systemWaypoints.find(({ type }) => type === 'JUMP_GATE');

  let db;
  try {
    db = await pool.getConnection();
    await db.beginTransaction();

    // Add system to systems table
    if (jumpgateWaypoint?.symbol) {
      await db.query(`REPLACE INTO systems (systemSymbol, jumpgateWaypoint)
        VALUES ("${systemSymbol}", "${jumpgateWaypoint.symbol}")`);
    } else {
      await db.query(`REPLACE INTO systems (systemSymbol, jumpgateWaypoint)
        VALUES ("${systemSymbol}", NULL)`);
    }

    // Add waypoints to waypoints table one at a time
    await systemWaypoints.reduce(async (prevPromise, w) => {
      await prevPromise;
      const hasMarketplace = w.traits.some(({ symbol }) => symbol === 'MARKETPLACE');
      const hasShipyard = w.traits.some(({ symbol }) => symbol === 'SHIPYARD');
      await db.query(`REPLACE INTO waypoints
        (systemSymbol, waypointSymbol, type, marketplace, shipyard)
        VALUES ("${w.systemSymbol}", "${w.symbol}", "${w.type}", ${hasMarketplace}, ${hasShipyard})`);
    }, Promise.resolve());

    // Get what's available at the shipyard
    const shipyardWaypoints = systemWaypoints.filter(({ traits }) =>
      traits.some(({ symbol }) => symbol === 'SHIPYARD')
    );
    if (shipyardWaypoints.length > 0) {
      // Record what's available in the shipyard
      await shipyardWaypoints.reduce(async (prevPromise, w) => {
        await prevPromise;
        // Get the ships that are available
        const { shipTypes } = await api.get(`/systems/${systemSymbol}/waypoints/${w.symbol}/shipyard`);
        await shipTypes.reduce(async (prevPromise, { type }) => {
          await prevPromise;
          // Add the ship type to the total list of ships
          await db.query(`REPLACE INTO shipTypes values ("${type}")`);
          // Link that ship type with the shipyard
          await db.query(`REPLACE INTO shipyard_ships (waypointSymbol, shipType)
            values ("${w.symbol}", "${type}")`);
        }, Promise.resolve());
      }, Promise.resolve());
    }

    await db.commit();
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }

  // Get where we can jump from this system
 await localApi.get(`systems/${systemSymbol}/waypoints/${jumpgateWaypoint.symbol}/jump-gate`)
   .then(async (jumpgateResponse) => {
     const { connectedSystems } = jumpgateResponse.data.data;
     if  (connectedSystems?.length > 0) {
       // Filter out systems that we've already scanned
       const systemsToScan = connectedSystems.filter(({ symbol }) => !scannedSystems.includes(symbol));
       scannedSystems.push(...systemsToScan.map(({ symbol }) => symbol));

       // Mark the possible jump paths
       try {
         db = await pool.getConnection();
         await connectedSystems.reduce(async (prevPromise, s) => {
           await prevPromise;
           await addJumpPath(systemSymbol, s.symbol, pool);
         }, Promise.resolve());

       } catch (error) {
         console.log(error);
       } finally {
         db.release();
       }

       // Scan unscanned systems recursively
       if (depth < depthLimit) {
         await systemsToScan.reduce(async (prevPromise, { symbol }) => {
           await prevPromise;
           await scanSystemRecursive(symbol, pool, depth + 1);
         }, Promise.resolve());
       }
     }

   })
   .catch(err => {
     // System not surveyed
   });

}

const addJumpPath = async (system1, system2, pool) => {
  // Has this jump path been indexed yet?
  let db;
  try {
    db = await pool.getConnection();

    const result1 = await db.query(`SELECT systemA, systemB FROM jumpPaths where systemA = "${system1}"`);
    const result1Match = result1.find(({ systemB }) => systemB === system2);
    if (result1Match) {
      // It's already in there
      return;
    }
    // With no results, result1 is an empty array
    const result2 = await db.query(`SELECT systemA, systemB FROM jumpPaths where systemB = "${system1}"`);
    const result2Match = result2.find(({ systemA }) => systemA === system2);
    if (result2Match) {
      // It's already in there
      return;
    }

    // Add the new jump path
    await db.query(`INSERT INTO jumpPaths (systemA, systemB) VALUES ("${system1}", "${system2}")`);

  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
  // If no, add it

}

scanSystems('X1-QM77', pool)
  .catch(console.error)
  .finally(() => pool.end());

module.exports = {
  scanSystems,
}
