require('dotenv').config();
const api = require('./api');
const { singleQuery } = require('./databaseUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const getSystemFromWaypoint = (waypointSymbol) => {
  const stringSplit = waypointSymbol.split('-');
  return `${stringSplit[0]}-${stringSplit[1]}`;
}

// Create a mining survey and write it to the database
const survey = async (shipSymbol, pool) => {

  await api.orbit(shipSymbol);

  const cooldownResponse = await api.cooldown(shipSymbol);
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }

  const surveyResponse = await api.survey(shipSymbol)
    .catch((err) => {
      console.log('Mining survey failed; is the ship', shipSymbol, 'at a mining location?');
      console.log(JSON.stringify(err, null, 2));
    });
  await writeSurveys(surveyResponse.surveys, pool);
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

const extract = async (shipSymbol, pool) => {
  const { nav: { waypointSymbol } } = await api.ship(shipSymbol);
  const cooldownResponse = await api.cooldown(shipSymbol);
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
  const now = new Date();
  const data = dataWithExpiration.filter(({ expiration }) => {
    const expDate = Date.parse(expiration);
    return expDate > now;
  });
  await api.orbit(shipSymbol);
  if (data.length === 0) {
    // No survey found
    console.log(shipSymbol, 'extracting without survey');
    return api.post(`/my/ships/${shipSymbol}/extract`);
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
  console.log(shipSymbol, 'extracting with survey');
  return api.post(`/my/ships/${shipSymbol}/extract`, {
    surveys,
  });
}

const extractUntilFull = async (shipSymbol, contractTradeSymbol, pool) => {
  const ship = await api.ship(shipSymbol);
  var remainingCapacity = ship.cargo.capacity - ship.cargo.units;
  while (remainingCapacity > 0) {
    const extractResponse = await extract(shipSymbol, pool);
    remainingCapacity = extractResponse?.cargo.capacity - extractResponse?.cargo.units;

    if (contractTradeSymbol) {
      let db;
      try {
        db = await pool.getConnection();
        const myOrders = (await db.query(`SELECT orders FROM ships where symbol = "${shipSymbol}"`))[0].orders;

        if (myOrders !== "deliver") {
          // Transfer cargo to delivery ship
          // Do I have any of the contract delivery symbol?
          const { cargo: { inventory } } = await api.ship(shipSymbol);
          const contractInventory = inventory.find(({ symbol }) => symbol === contractTradeSymbol);
          if (contractInventory) {

            // Is there a delivery ship here?
            const deliveryShipSymbols = (await db.query(`select symbol from ships where orders = "deliver"`))
            .map(({ symbol }) => symbol);
            const deliveryShipsHere = await deliveryShipSymbols.reduce(async (prevListPromise, s) => {
              var prevList = await prevListPromise;
              const deliveryShipData = await api.ship(s);
              if (deliveryShipData?.nav?.waypointSymbol === ship.nav.waypointSymbol) {
                prevList.push(s);
              }
              return prevList;
            }, []);

            // Transfer contract content to delivery ships
            var unitsToTransfer = contractInventory.units;
            while (unitsToTransfer > 0 && deliveryShipsHere.length > 0) {
              const oneDeliveryShip = deliveryShipsHere.pop();
              // Get capacity of delivery ship
              const { cargo: { capacity, units } } = await api.ship(oneDeliveryShip);
              if (units < capacity) {
                const unitsToTransferThisTime = Math.min(unitsToTransfer, capacity - units);
                unitsToTransfer -= unitsToTransferThisTime;
                await api.post(`/my/ships/${shipSymbol}/transfer`, {
                  tradeSymbol: contractTradeSymbol,
                  units: unitsToTransferThisTime,
                  shipSymbol: oneDeliveryShip,
                });
              }
            }
          }

        }

      } catch (error) {
        console.log(error);
      } finally {
        db.release();
      }
    }

    await timer(extractResponse.cooldown.remainingSeconds || 0 + 1);
  }
}

const getJumpgateWaypointSymbol = async (systemSymbol) => {
  const waypointsInSystem = await api.waypoints(systemSymbol);
  const jumpgateWaypoint = waypointsInSystem.find(({ type }) => type === 'JUMP_GATE');
  if (jumpgateWaypoint) {
    return jumpgateWaypoint.symbol;
  }
}

module.exports = {
  timer,
  writeSurveys,
  survey,
  extract,
  extractUntilFull,
  getSystemFromWaypoint,
  getJumpgateWaypointSymbol,
}
