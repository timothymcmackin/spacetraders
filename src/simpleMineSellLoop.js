require('dotenv').config();
const api = require('./utils/api');
const {
  updateShipIsActive,
  releaseShip,
  restartInactiveShips,
  getPool,
  getShipsByOrders,
  getGlobalOrders,
  singleQuery,
} = require('./utils/databaseUtils');
const {
  timer,
  survey,
  extractUntilFull,
} = require('./utils/utils');

const pool = getPool();

const main = async () => {

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
          await releaseShip(s, pool)
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
          await releaseShip(s, pool)
        })
    );
    if (allMinersPromises.length) {
      allPromises.push(...allMinersPromises);
    }

    await timer(60);
    globalOrders = await getGlobalOrders(pool);
  }
  // After global orders change, wait for everyone to finish their task
  // before closing down
  await Promise.all(allPromises);

}

// Assume we're at a marketplace
// Be sure to check that they have a market for the good
const sellAll = async (shipSymbol, dumpUnsold = false) => {
  const { nav, cargo } = await api.ship(shipSymbol);
  const { systemSymbol, waypointSymbol } = nav;
  const { inventory } = cargo;
  if (inventory.length === 0) {
    console.log(shipSymbol, "doesn't have anything to sell");
    return;
  }

  // Get the marketplace data
  const marketplaceData = await api.get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
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
          const { transaction } = await api.post(`/my/ships/${shipSymbol}/sell`, {
            symbol: materialSymbol,
            units: unitsToSellThisTime,
          });
          totalSalePrice += transaction.totalPrice;
          unitsToSell -= unitsToSellThisTime;
        }
      } else {
        // Can't sell here, so dump it
        if (dumpUnsold) {
          console.log('Jettisoning', units, 'units of ', materialSymbol);
          return api.post(`/my/ships/${shipSymbol}/jettison`, {
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
  const cooldownResponse = await api.cooldown(shipSymbol);
  console.log(shipSymbol, 'Mine loop cooldown', cooldownResponse ? cooldownResponse.remainingSeconds : 'null');
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }

  await api.orbit(shipSymbol);

  await extractUntilFull(shipSymbol, pool);

  // Beginner starting system always has a marketplace at the asteroid field
  await api.dock(shipSymbol);

  const profit = await sellAll(shipSymbol, true);

  // Need to await here because otherwise the database gets closed before this runs
  await api.agent()
    .then(({ credits }) =>
      singleQuery(`INSERT INTO credits (credits, event, date)
        VALUES ("${credits}", "Selling mined resources", "${Date.now().toString()}")`, pool)
    );
  console.log('Mining profit:', profit);
}

main()
  .catch(console.error)
  .finally(() => {
    console.log('close DB pool');
    pool.end();
  });