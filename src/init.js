require('dotenv').config();
const api = require('./utils/api');
const { initDatabase, getPool } = require('./utils/databaseUtils');
const { scanSystems } = require('./scanSystems');
const { findGoodSystems } = require('./findGoodSystems');

const pool = getPool();

const main = async () => {
  // await initDatabase(pool);
  // Get starting system
  const ships = await api.ships();
  const startingLocation = ships[0].nav.systemSymbol;
  // Populate the database
  await scanSystems(startingLocation, pool);
  await findGoodSystems(pool)
}

main()
  .catch(console.error)
  .finally(() => pool.end());
