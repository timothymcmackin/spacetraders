require('dotenv').config();
const mariadb = require('mariadb');
const flatten = require('lodash/flatten');
const api = require('./api');

const getPool = () => mariadb.createPool({
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

// async function fetchConnectionFromPool(pool) {
//   let conn = await pool.getConnection();
//   // console.log("Total connections: ", pool.totalConnections());
//   // console.log("Active connections: ", pool.activeConnections());
//   // console.log("Idle connections: ", pool.idleConnections());
//   return conn;
// }

// Set up the database
// Assumes that there is a database but it's currently empty
const initDatabase = async (pool) => {
  let db;
  try {
    db = await pool.getConnection();
    const currentTables = flatten(await db.query('SHOW TABLES'))
      .map(({Tables_in_spacetraders}) => Tables_in_spacetraders);

    // Create a table to keep track of ships
    if (currentTables.includes('ships')) {
      await db.query('DROP TABLE ships');
    }
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
    const shipData = await api.ships();
    const myShips = shipData.map(({ symbol, registration, cargo }) => ({
        symbol,
        role: registration.role,
        cargoCapacity: cargo.capacity,
      }));
    // console.log(ships);
    // Add ships
    await db.beginTransaction();
    // Maybe one at a time? Instead of mapping to an array of promises?
    await myShips.reduce(async (prevPromise, {symbol, role, cargoCapacity}) => {
      await prevPromise;
      return db.query(`INSERT INTO ships (symbol, role, cargoCapacity) VALUES ("${symbol}", "${role}", ${cargoCapacity})`);
    }, Promise.resolve());
    await db.commit();

    // List of ship types for sale
    if (currentTables.includes('shipTypes')) {
      await db.query('DROP TABLE shipTypes');
    }
    await db.query(`CREATE TABLE shipTypes (
      shipType varchar(255),
      PRIMARY KEY (shipType))`);

    // Connection of which ships are available at which shipyard
    if (currentTables.includes('shipyard_ships')) {
      await db.query('DROP TABLE shipyard_ships');
    }
    await db.query(`CREATE TABLE shipyard_ships (
      id int NOT NULL AUTO_INCREMENT,
      waypointSymbol varchar(255),
      shipType varchar(255),
      PRIMARY KEY (id))`);

    if (currentTables.includes('marketplaceData')) {
      await db.query('DROP TABLE marketplaceData');
    }
    // Clear marketplace data
    await db.query(`CREATE TABLE marketplaceData (
      systemSymbol varchar(255) NOT NULL,
      waypointSymbol varchar(255) NOT NULL,
      symbol varchar(255) NOT NULL,
      tradeVolume int,
      supply varchar(255),
      purchasePrice int,
      sellPrice int,
      updateTime varchar(255),
      PRIMARY KEY (systemSymbol, waypointSymbol, symbol))`);

    if (currentTables.includes('jumpPaths')) {
      await db.query('DROP TABLE jumpPaths');
    }
    // Where you can go from each jump gate
    await db.query(`CREATE TABLE jumpPaths (
      id int NOT NULL AUTO_INCREMENT,
      systemA varchar(255),
      systemB varchar(255),
      PRIMARY KEY (id))`);

    if (currentTables.includes('waypoints')) {
      await db.query('DROP TABLE waypoints');
    }
    await db.query(`CREATE TABLE waypoints (
      systemSymbol varchar(255) NOT NULL,
      waypointSymbol varchar(255) NOT NULL,
      type varchar(255),
      marketplace Boolean,
      shipyard Boolean,
      PRIMARY KEY (waypointSymbol))`);

    // Trade records
    if (currentTables.includes('transactions')) {
      await db.query('DROP TABLE transactions');
    }
    await db.query(`CREATE TABLE transactions(
      id int NOT NULL AUTO_INCREMENT,
      purchaseWaypoint varchar(255) NOT NULL,
      saleWaypoint varchar(255) NOT NULL,
      tradeGood varchar(255) NOT NULL,
      estimatedprofitPerItem int NOT NULL,
      actualProfitPerItem int NOT NULL,
      units int,
      PRIMARY KEY (id))
    `);

    if (currentTables.includes('systems')) {
      await db.query('DROP TABLE systems');
    }
    await db.query(`CREATE TABLE systems (
      systemSymbol varchar(255) NOT NULL,
      jumpgateWaypoint varchar(255) NOT NULL,
      explored Boolean DEFAULT FALSE,
      PRIMARY KEY (systemSymbol))`);

    if (currentTables.includes('surveys')) {
      await db.query('DROP TABLE surveys');
    }
    // Note that the surveySignature starts with the waypointSymbol
    await db.query(`CREATE TABLE surveys (
      id int NOT NULL AUTO_INCREMENT,
      waypointSymbol varchar(255),
      surveySignature varchar(255),
      expiration varchar(255),
      depositSymbol varchar(255),
      size varchar(255),
      PRIMARY KEY (id))`);

    if (currentTables.includes('globalOrders')) {
      await db.query('DROP TABLE globalOrders');
    }
    await db.query(`CREATE TABLE globalOrders (
      globalOrder varchar(255) NOT NULL,
      PRIMARY KEY (globalOrder))`);

    if (currentTables.includes('credits')) {
      await db.query('DROP TABLE credits');
    }
    await db.query(`CREATE TABLE credits (
      id int NOT NULL AUTO_INCREMENT,
      credits int NOT NULL,
      date varchar(255),
      event varchar(255),
      PRIMARY KEY (id))`);

  } catch (error) {
    console.log(error);
  } finally {
    db.end();
  }
}

// Get ships with specific orders
const getShipsByOrders = async (orders, pool, includeActive = false) => {
  let db;
  try {
    db = await pool.getConnection();
    if (includeActive) {
      ships = flatten(await db.query(`SELECT symbol FROM ships WHERE orders = "${orders}"`));
      return ships.map(({ symbol }) => symbol);
    } else {
      ships = flatten(await db.query(`SELECT symbol FROM ships WHERE orders = "${orders}" and lastActive IS NULL`));
      return ships.map(({ symbol }) => symbol);
    }
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
const controlShip = async (symbol, pool) => {
  let db;
  try {
    db = await pool.getConnection();
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

const updateShipIsActive = async (symbol, pool) => {
  let db;
  try {
    db = await pool.getConnection();
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

const releaseShip = async (symbol, pool) => {
  let db;
  try {
    db = await pool.getConnection();
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
const getActiveTimeMinutes = async (symbol, pool) => {
  let db;
  try {
    db = await pool.getConnection();
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
const restartInactiveShips = async (minutes, roles, pool) => {
  let db;
  const now = new Date();
  try {
    db = await pool.getConnection();
    const roleMap = roles.map((oneRole) => `"${oneRole}"`).join(',');
    const ships = await db.query(`SELECT symbol, lastActive FROM ships
      where role in (${roleMap})`);
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

// Keep the ships table updated
// Could I do this with a map, or would I overload the database connection pool?
const updateShipTable = async (pool) => {
  const allShips = await api.ships();
  return allShips.reduce(async (prevPromise, ship) => {
    await prevPromise;
    const {
      symbol,
      cargo: {
        capacity,
      },
      registration: {
        role,
      },
    } = ship;
    // Symbol is the primary key so this returns a zero or  one-element array
    const existingShipData = await singleQuery(`SELECT symbol, role, cargoCapacity FROM ships
    where symbol = "${symbol}"`, pool);
    if (existingShipData.length === 0) {
      await singleQuery(`INSERT INTO ships (symbol, role, cargoCapacity)
      VALUES ("${symbol}", "${role}", "${capacity}")`);
    }
  }, Promise.resolve());
}

const endPool = () => {
  pool.end();
}

const getOrders = async (symbol) => {
  let db;
  try {
    db = await pool.getConnection();
    const ordersResponse = await db.query(`SELECT orders from ships
      WHERE symbol = "${symbol}"`);
    return ordersResponse[0].orders;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

// Couldn't find a profitable trade in this system, so get a random jump gate waypoint in a different system
const getDifferentSystemJumpgateWaypoint = async (currentSystem) => {
  let db;
  try {
    db = await pool.getConnection();
    const systemsResponse = await db.query(`SELECT jumpGateWaypoint from systems
      WHERE systemSymbol != "${currentSystem}"`);
    const systems = systemsResponse.map(({ jumpGateWaypoint }) => jumpGateWaypoint);
    const targetWaypoint = systems[Math.floor(Math.random() * systems.length)];
    return targetWaypoint;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

/*
[
  { systemSymbol: 'X1-CQ5', jumpGateWaypoint: 'X1-CQ5-30517D' },
  { systemSymbol: 'X1-DD46', jumpGateWaypoint: 'X1-DD46-05015B' },
  { systemSymbol: 'X1-YU85', jumpGateWaypoint: 'X1-YU85-14659B' }
]
*/
const getAllSystemsAndJumpGates = async () => {
  let db;
  try {
    db = await pool.getConnection();
    const systemsResponse = await db.query(`SELECT systemSymbol, jumpGateWaypoint from systems`);
    return systemsResponse;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const singleQuery = async (queryString, pool) => {
  let db;
  try {
    db = await pool.getConnection();
    return await db.query(queryString);
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const getGlobalOrders = async (pool) => {
  const ordersArray = await singleQuery('SELECT globalOrder FROM globalOrders', pool);
  return ordersArray.map(({ globalOrder }) => globalOrder);
}

module.exports = {
  getPool,
  initDatabase,
  getActiveTimeMinutes,
  controlShip,
  updateShipIsActive,
  restartInactiveShips,
  releaseShip,
  endPool,
  getOrders,
  getDifferentSystemJumpgateWaypoint,
  getAllSystemsAndJumpGates,
  singleQuery,
  getShipsByOrders,
  updateShipTable,
  getGlobalOrders,
};

// initDatabase()
//   .then(endPool)