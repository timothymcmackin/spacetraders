require('dotenv').config();
const api = require('./utils/api');
const { initDatabase, getPool } = require('./utils/databaseUtils');
const { scanSystems } = require('./scanSystems');
const { findGoodSystems } = require('./findGoodSystems');

const pool = getPool();

initDatabase(pool)
  .then(async () => {
    // Get starting system
    const ships = await api.ships();
    const startingLocation = ships[0].nav.waypointSymbol;
    // Populate the database
    await scanSystems(startingLocation, pool);
  })
  .then(async () => findGoodSystems(pool))
  .catch(console.error)
  .finally(() => pool.end());
