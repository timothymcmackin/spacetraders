require('dotenv').config();
const mariadb = require('mariadb');
const flatten = require('lodash/flatten');
const {
  get,
} = require('./utils');

const { log } = require('./utils');

// https://github.com/sidorares/node-mysql2
// connection never releases with this method
// const pool = mariadb.createPool({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
//   waitForConnections: true,
//   connectionLimit: 5,
//   maxIdle: 5, // max idle connections, the default value is the same as `connectionLimit`
//   idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
//   queueLimit: 0,
//   enableKeepAlive: true,
//   keepAliveInitialDelay: 0
// });

// Returns Promise
const getConnection = () => mariadb.createConnection({
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
    db = await getConnection();
    const currentTables = flatten(await db.query('SHOW TABLES'));

    // Create a table to keep track of mining ships
    if (!currentTables.includes('miningShips')) {
      const createMiningQuery = `CREATE TABLE miningShips (
        symbol varchar(255) NOT NULL,
        lastActive varchar(255),
        PRIMARY KEY (symbol)
      )`;
      await db.query(createMiningQuery);

      // Add mining ships
      const ships = await get('/my/ships');
      const miningShips = ships.filter(({ registration }) => registration.role === 'EXCAVATOR')
        .map(({ symbol }) => symbol);
      console.log(miningShips);
      await db.beginTransaction();
      // Maybe one at a time?
      await miningShips.reduce(async (prevPromise, symbol) => {
        await prevPromise;
        return db.query(`INSERT INTO miningShips (symbol) VALUES ("${symbol}")`);
      }, Promise.resolve());
      await db.commit();
    }

  } catch (error) {
    console.log(error);
  } finally {
    db.end(); // No need to await this or return it; it'll close eventually, I think, or is it better to wait for it to close?
  }


}

const getAvailableMiningShips = async () => {
  let db, availableMiningShips;
  try {
    db = await getConnection();
    availableMiningShips = flatten(await db.query('SELECT symbol FROM miningShips WHERE lastActive IS NULL'));
    console.log(availableMiningShips);
  } catch (error) {
    console.log(error);
  } finally {
    db.end();
  }
  if (availableMiningShips) return availableMiningShips;
}

// Marks a ship as in use.
// Returns false if the ship is already in use.
// Maybe should throw an exception instead?
// I'm just thinking of workers trying to grab the same ship at once.
const controlMiningShip = async (symbol) => {
  let db;
  try {
    db = await getConnection();
    // Check that it is available
    const [lastActive] = flatten(await db.query(`SELECT lastActive FROM miningShips where symbol = "${symbol}"`));
    if (lastActive) {
      // Ship has a last active date, so it's in use
      return false;
    }
    await db.query(`UPDATE miningShips SET
      lastActive = "${new Date()}"
      WHERE symbol = "${symbol}"`);
    return true;
  } catch (error) {
    console.log(error);
  } finally {
    db.end();
  }
}

const releaseMiningShip = async (symbol) => {
  let db;
  try {
    db = await getConnection();
    // No need to check that it is active?
    await db.query(`UPDATE miningShips SET
      lastActive = NULL
      WHERE symbol = "${symbol}"`);
  } catch (error) {
    console.log(error);
  } finally {
    db.end();
  }
}

const addRelease = async (symbol) => {
  await controlMiningShip(symbol);
  await releaseMiningShip(symbol);
}
addRelease('PINCKNEY-3');

module.exports = {
  initDatabase,
  getAvailableMiningShips,
};
