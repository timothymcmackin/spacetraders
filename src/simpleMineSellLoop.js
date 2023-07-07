require('dotenv').config();
const mariadb = require('mariadb');
const flatten = require('lodash/flatten');
const {
  get,
  post,
} = require('./utils/api');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const dbPool = mariadb.createPool({
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

const getGlobalOrders = async (pool) => {
  const ordersArray = await singleQuery('SELECT globalOrder FROM globalOrders', pool);
  return ordersArray.map(({ globalOrder }) => globalOrder);
}

const writeSurveys = async (surveys, pool) => {
  let db;
  try {
    db = await pool.getConnection();
    await db.beginTransaction();
    if (surveys && surveys.length > 0) {
      await surveys.reduce(async (prevPromise, oneSurvey) => {
        const { signature, deposits, expiration, size, symbol: waypointSymbol } = oneSurvey;
        // Delete old surveys
        await db.query(`DELETE FROM surveys WHERE waypointSymbol = "${waypointSymbol}"`);
        await deposits.reduce(async (nextPrevPromise, { symbol: depositSymbol }) => {
          await nextPrevPromise;
          const queryString = `INSERT INTO surveys
          (waypointSymbol, surveySignature, expiration, depositSymbol, size)
          VALUES ("${waypointSymbol}","${signature}", "${expiration}", "${depositSymbol}", "${size}")`;
          return db.query(queryString);
        }, prevPromise);
      }, Promise.resolve());
    } else {
      console.log('Got an empty survey.');
    }

    await db.commit();
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }

}

// Create a mining survey and write it to the database
const survey = async (shipSymbol, pool) => {
  const cooldownResponse = await get(`/my/ships/${shipSymbol}/cooldown`);
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }

  await post(`/my/ships/${shipSymbol}/orbit`);

  const surveyResponse = await post(`/my/ships/${shipSymbol}/survey`)
    .catch((err) => {
      console.log('Mining survey failed; is the ship', shipSymbol, 'at a mining location?');
      console.log(JSON.stringify(err, null, 2));
    });
  await writeSurveys(surveyResponse.surveys, pool);
}

const releaseShip = async (symbol, pool) =>
  singleQuery(`UPDATE ships SET
    lastActive = NULL
    WHERE symbol = "${symbol}"`, pool);

const main = async () => {

  const pool = dbPool;
  const miningLocation = 'X1-YU85-76885D';

  var globalOrders = await getGlobalOrders(pool);

  var allPromises = [];

  while(globalOrders.includes('mineAndTrade')) {
    console.log('Main loop');
    await restartInactiveShips(10, ['COMMAND', 'EXCAVATOR'], pool);

    const availableMiners = await getShipsByOrders('mine', pool);
    const availableSurveyors = await getShipsByOrders('survey', pool);

    const allSurveyorsPromises = availableSurveyors.map((s) =>
      updateShipIsActive(s, pool)
        .then(() => survey(s, pool))
        .then(() => mineLoop(s, pool))
        .catch(console.error)
        .finally(async () => {
          console.log(s, 'finally before releaseShip')
          await releaseShip(s, pool)
          console.log(s, 'finally after releaseShip')
        })
    );
    if (allSurveyorsPromises.length) {
      allPromises.push(...allSurveyorsPromises);
    }

    const allMinersPromises = availableMiners.map((s) =>
      updateShipIsActive(s, pool)
        .then(() => mineLoop(s, pool))
        .catch(console.error)
        .finally(async () => {
          console.log(s, 'finally before releaseShip')
          await releaseShip(s, pool)
          console.log(s, 'finally after releaseShip')
        })
    );
    if (allMinersPromises.length) {
      allPromises.push(...allMinersPromises);
    }
    console.log('Promises complete');

    await timer(60);
    globalOrders = await getGlobalOrders(pool);
  }
  // After global orders change, wait for everyone to finish their task
  // before closing down
  await Promise.all(allPromises);

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

const surveyLoop = async (shipSymbol, pool) => {
  var cooldownResponse = await get(`/my/ships/${shipSymbol}/cooldown`);
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }

  await post(`/my/ships/${shipSymbol}/orbit`);

  await survey(shipSymbol, pool);
  console.log(shipSymbol, 'surveyed');
  cooldownResponse = await get(`/my/ships/${shipSymbol}/cooldown`);
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }
  // Wait a while because the surveys are good for a while
  await timer(300);
}

const extract = async (shipSymbol, pool) => {
  console.log(shipSymbol, 'Begin extract');
  const { nav: { waypointSymbol } } = await get(`/my/ships/${shipSymbol}`);
  const cooldownResponse = await get(`/my/ships/${shipSymbol}/cooldown`);
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }
  // Check for a survey in the database
  const queryString = `SELECT waypointSymbol, surveySignature, expiration, depositSymbol, size
  FROM surveys
  WHERE waypointSymbol = "${waypointSymbol}"`;
  // How to get these in order?
  // Currently I'm auto-deleting the older ones from the database, so you should only get one survey
  const dataWithExpiration = await singleQuery(queryString, pool);
  console.log(shipSymbol, 'Got survey data');
  const now = new Date();
  const data = dataWithExpiration.filter(({ expiration }) => {
    const expDate = Date.parse(expiration);
    return expDate > now;
  });
  await post(`/my/ships/${shipSymbol}/orbit`);
  if (data.length === 0) {
    // No survey found
    console.log(shipSymbol, 'Mining without survey');
    return post(`/my/ships/${shipSymbol}/extract`);
  }
  // Reconstruct survey object because it's apparently all required?
  // "surveys": [
  //   {
  //     "signature": "string",
  //     "symbol": "string",
  //     "deposits": [
  //       {
  //         "symbol": "string"
  //       }
  //     ],
  //     "expiration": "2019-08-24T14:15:22Z",
  //     "size": "SMALL"
  //   }
  // Get an array of the survey signatures
  const surveySignatures = data.reduce((allSigs, { surveySignature }) => {
    if (!allSigs.includes(surveySignature)) {
      allSigs.push(surveySignature);
    }
    return allSigs;
  }, []);
  // Assemble the full object
  const surveys = surveySignatures.map((oneSurveySignature) => {
    const matchingDeposits = data.filter(({ surveySignature }) => surveySignature === oneSurveySignature);
    const deposits = matchingDeposits.map(({ depositSymbol }) => ({
      symbol: depositSymbol,
    }));
    return {
      signature: oneSurveySignature,
      symbol: matchingDeposits[0].waypointSymbol,
      deposits,
      expiration: matchingDeposits[0].expiration,
      size: matchingDeposits[0].size,
    };
  });
  console.log(shipSymbol, 'mining with survey');
  return post(`/my/ships/${shipSymbol}/extract`, {
    surveys,
  })
    .then(() =>
      console.log(shipSymbol, 'Completed extract')
    );
}

const extractUntilFull = async (shipSymbol, pool) => {
  console.log(shipSymbol, 'Begin extract until full');
  const ship = await get('/my/ships/' + shipSymbol);
  var remainingCapacity = ship.cargo.capacity - ship.cargo.units;
  while (remainingCapacity > 0) {
    const extractResponse = await extract(shipSymbol, pool);
    remainingCapacity = extractResponse?.cargo.capacity - extractResponse?.cargo.units;
    if (remainingCapacity > 0) {
      await timer(extractResponse.cooldown.remainingSeconds || 0 + 1);
    }
  }
  console.log(shipSymbol, 'End extract until full');
}

// Assume we're at a marketplace
// Be sure to check that they have a market for the good
const sellAll = async (shipSymbol, dumpUnsold = false) => {
  const { nav, cargo } = await get(`/my/ships/${shipSymbol}`);
  const { systemSymbol, waypointSymbol } = nav;
  const { inventory } = cargo;
  if (inventory.length === 0) {
    console.log(shipSymbol, "doesn't have anything to sell");
    return;
  }

  // Get the marketplace data
  const marketplaceData = await get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
  const { tradeGoods } = marketplaceData;
  const thingsWeCanSellHere = tradeGoods.map(({ symbol }) => symbol);

  var totalSalePrice = 0;
  if (inventory.some(({ units }) => units > 0)) {
    // Sell everything
    // One good at a time due to limitations in the API
    await inventory.reduce(async (prevPromise, { symbol: materialSymbol, units }) => {
      await prevPromise;
      // Can we sell this here?
      if (thingsWeCanSellHere.includes(materialSymbol)) {
        // limit by tradeVolume
        var unitsToSell = units;
        const tradeVolume = tradeGoods.find(({ symbol }) => symbol == materialSymbol).tradeVolume;
        while (unitsToSell > 0) {
          const unitsToSellThisTime = Math.min(unitsToSell, tradeVolume);
          const { transaction } = await post(`/my/ships/${shipSymbol}/sell`, {
            symbol: materialSymbol,
            units: unitsToSellThisTime,
          });
          totalSalePrice += transaction.totalPrice;
          unitsToSell -= unitsToSellThisTime;
        }
      } else {
        // Can't sell here, so dump it
        if (dumpUnsold) {
          return post(`/my/ships/${shipSymbol}/jettison`, {
            symbol: materialSymbol,
            units,
          });
        }
      }
    }, Promise.resolve());
    console.log(shipSymbol, 'sold cargo');
  }
  return totalSalePrice;
}

const mineLoop = async (shipSymbol, pool) => {
  console.log(shipSymbol, 'Begin mine loop');
  const cooldownResponse = await get(`/my/ships/${shipSymbol}/cooldown`);
  console.log(shipSymbol, 'Mine loop cooldown', cooldownResponse ? cooldownResponse.remainingSeconds : 'null');
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }

  console.log(shipSymbol, 'Begin orbit');
  await post(`/my/ships/${shipSymbol}/orbit`);
  console.log(shipSymbol, 'Orbited');

  await extractUntilFull(shipSymbol, pool);

  // Beginner starting system always has a marketplace at the asteroid field
  console.log(shipSymbol, 'Begin dock');
  await post(`/my/ships/${shipSymbol}/dock`);
  console.log(shipSymbol, 'docked');

  console.log(shipSymbol, 'Begin sell all');
  const profit = await sellAll(shipSymbol, true);
  console.log(shipSymbol, 'Sell all complete');

  // Need to await here because otherwise the database gets closed before this runs
  console.log(shipSymbol, 'Begin get agent');
  await get('/my/agent')
    .then(({ credits }) =>
      singleQuery(`INSERT INTO credits (credits, event, date)
        VALUES ("${credits}", "Selling mined resources", "${Date.now().toString()}")`, pool)
    )
    .then(() =>
      console.log(shipSymbol, 'Begin extract until full')
    );
  console.log('Mining profit:', profit);
}

main()
  .catch(console.error)
  .finally(() => {
    console.log('close DB pool');
    dbPool.end();
  });