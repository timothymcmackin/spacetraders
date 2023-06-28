require('dotenv').config();
const mariadb = require('mariadb');
const flatten = require('lodash/flatten');
const {
  get,
  timer,
} = require('./utils');

const { log } = require('./utils');

// https://github.com/sidorares/node-mysql2
// connection never releases with this method
const pool = mariadb.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  maxIdle: 5, // max idle connections, the default value is the same as `connectionLimit`
  idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  resetAfterUse: true,
});

async function fetchConnectionFromPool() {
  let conn = await pool.getConnection();
  // console.log("Total connections: ", pool.totalConnections());
  // console.log("Active connections: ", pool.activeConnections());
  // console.log("Idle connections: ", pool.idleConnections());
  return conn;
}

// Returns Promise
const getConnection = () => pool.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    rowsAsArray: true,
});

// Set up the database
// Assumes that there is a database but it's currently empty
const initDatabaseFromPool = async () => {
  // let connection;
  try {
    // connection = await pool.getConnection();
    // const currentTables = await connection.query('SHOW TABLES');
    // console.log(currentTables);
  } catch (error) {
    log(error);
  } finally {
    // if (connection) return connection.release(); //release to pool
  }
}

// Set up the database
// Assumes that there is a database but it's currently empty
const initDatabase = async () => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    // const currentTables = flatten(await db.query('SHOW TABLES'));

    // Create a table to keep track of mining ships
    await db.query('DROP TABLE ships')
      .catch(); // Do nothing
    // Should use a date data type for lastActive
    const createShipsTable = `CREATE TABLE ships (
      symbol varchar(255) NOT NULL,
      role varchar(255),
      cargoCapacity int,
      lastActive varchar(255),
      orders varchar(255),
      PRIMARY KEY (symbol)
    )`;
    await db.query(createShipsTable);

    // Add ships
    const shipData = await get('/my/ships');
    // const shipData = require('./cache/ships.json');
    const ships = shipData.map(({ symbol, registration, cargo }) => ({
        symbol,
        role: registration.role,
        cargoCapacity: cargo.capacity,
      }));
    // console.log(ships);
    await db.beginTransaction();
    // Maybe one at a time? Instead of mapping to an array of promises?
    await ships.reduce(async (prevPromise, {symbol, role, cargoCapacity}) => {
      await prevPromise;
      return db.query(`INSERT INTO ships (symbol, role, cargoCapacity) VALUES ("${symbol}", "${role}", ${cargoCapacity})`);
    }, Promise.resolve());
    await db.commit();

    // Clear marketplace data
    await db.query(`DROP TABLE marketplaceData`);
    await db.query(`CREATE TABLE marketplaceData (
      systemSymbol varchar(255) NOT NULL,
      waypointSymbol varchar(255) NOT NULL,
      symbol varchar(255) NOT NULL,
      tradeVolume int,
      supply varchar(255),
      purchasePrice int,
      sellPrice int,
      PRIMARY KEY (systemSymbol, waypointSymbol, symbol)`);

      // Clear system data
      await db.query(`DROP TABLE waypoints`);
      await db.query(`CREATE TABLE waypoints (
        systemSymbol varchar(255) NOT NULL,
        waypointSymbol varchar(255) NOT NULL,
        deadEnd int DEFAULT 0,
        PRIMARY KEY (systemSymbol, waypointSymbol))`);

  } catch (error) {
    console.log(error);
  } finally {
    db.end(); // No need to await this or return it; it'll close eventually, I think, or is it better to wait for it to close?
  }

}

// Returns ['PINCKNEY-1', 'PINCKNEY-2']
const getAvailableMiningShips = async () => {
  let db, availableMiningShips;
  try {
    db = await fetchConnectionFromPool();
    availableMiningShips = flatten(await db.query('SELECT symbol FROM ships WHERE role = "EXCAVATOR" and lastActive IS NULL'));
    // console.log(availableMiningShips);
    return availableMiningShips.map(({ symbol }) => symbol);
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

// Marks a ship as in use.
// Returns false if the ship is already in use.
// Maybe should throw an exception instead?
// I'm just thinking of workers trying to grab the same ship at once.
const controlShip = async (symbol) => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    // Check that it is available
    const lastActive = await db.query(`SELECT lastActive FROM ships where symbol = "${symbol}"`);
    if (lastActive[0].lastActive) {
      // Ship has a last active date, so it's in use
      return false;
    }
    await db.query(`UPDATE ships SET
      lastActive = "${new Date()}"
      WHERE symbol = "${symbol}"`);
    return true;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const updateShipIsActive = async (symbol) => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    await db.query(`UPDATE ships SET
      lastActive = "${new Date()}"
      WHERE symbol = "${symbol}"`);
    return true;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const releaseShip = async (symbol) => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    // No need to check that it is active?
    await db.query(`UPDATE ships SET
      lastActive = NULL
      WHERE symbol = "${symbol}"`);
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

// Check how many minutes since a ship waas updated
const getActiveTimeMinutes = async (symbol) => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    const [lastActive] = flatten(await db.query(`SELECT lastActive FROM ships where symbol = "${symbol}"`));
    const lastActiveDate = Date.parse(lastActive.lastActive);
    const now = new Date();
    // console.log('active for', Math.round((now - lastActiveDate) / 1000), 'seconds.');
    return Math.floor((now - lastActiveDate) / (1000 * 60));
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

// Flush ships that have been inactive for a while because they are probably the result of a crash.
const restartInactiveShips = async (minutes, role) => {
  let db;
  const now = new Date();
  try {
    db = await fetchConnectionFromPool();
    const ships = await db.query(`SELECT symbol, lastActive FROM ships where role = "${role}"`);
    await db.beginTransaction();
    const restartedShips = await ships.reduce(async (prevPromise, { symbol, lastActive }) => {
      const prevAmount = await prevPromise;
      const lastActiveDate = Date.parse(lastActive);
      const minutesSince = (now - lastActiveDate) / (1000 * 60);
      if (minutesSince >= minutes) {
        console.log('Flushing inactive ship', symbol, 'after', minutes, 'minutes');
        await db.query(`UPDATE ships SET
          lastActive = NULL
          WHERE symbol = "${symbol}"`);
          return prevAmount + 1;
      }
      return prevAmount;
    }, Promise.resolve(0));

    await db.commit();
    return restartedShips;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const endPool = () => {
  pool.end();
}

const getOrders = async (symbol) => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    const ordersResponse = await db.query(`SELECT orders from ships
      WHERE symbol = "${symbol}"`);
      return ordersResponse[0].orders;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const test = async () => {
  console.log('test start');
  await controlShip('PINCKNEY-3');
  console.log('ok');
  await timer(22);
  await controlShip('PINCKNEY-4');
  console.log('ok');
  await timer(22);
  await controlShip('PINCKNEY-5');
  console.log('ok');
  await timer(22);
  await releaseShip('PINCKNEY-5');
  console.log('ok');
  await updateShipIsActive('PINCKNEY-4');
  console.log('ok');
  const restartedShips = await restartInactiveShips(1, 'EXCAVATOR');
  console.log('ok');
  if (restartedShips !== 1) {
    console.log('Test failed');
  }
  await restartInactiveShips(0, 'EXCAVATOR');
  console.log('test done');
}

module.exports = {
  test,
  initDatabase,
  getAvailableMiningShips,
  getActiveTimeMinutes,
  controlShip,
  updateShipIsActive,
  restartInactiveShips,
  releaseShip,
  endPool,
  fetchConnectionFromPool,
  getOrders,
};
