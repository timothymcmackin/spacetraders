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
const { getMostPofitableTrip } = require('./utils/tradeUtils');
const {
  timer,
  survey,
  extractUntilFull,
} = require('./utils/utils');
const { navigate } = require('./utils/navigationUtils');
const { isNumber } = require('lodash');

const pool = getPool();

const miningLocation = 'X1-QM77-50715F';

const main = async () => {

  var globalOrders = await getGlobalOrders(pool);

  var allPromises = [];

  while(globalOrders.includes('mineAndDeliver')) {
    console.log('Main loop');
    await restartInactiveShips(10, ['COMMAND', 'EXCAVATOR'], pool);

    const availableMiners = await getShipsByOrders('mine', pool);
    const availableSurveyors = await getShipsByOrders('survey', pool);
    const availableDeliverers = await getShipsByOrders('deliver', pool);

    const contractData = (await api.get(`/my/contracts`))[0];
    var contractTradeSymbol;
    if (contractData) {
      contractId = contractData.id;
      const { unitsRequired, unitsFulfilled } = contractData.terms.deliver[0];
      contractTradeSymbol = unitsRequired > unitsFulfilled ? contractData.terms.deliver[0].tradeSymbol : null;
    }

    const allSurveyorsPromises = availableSurveyors.map((s) =>
      updateShipIsActive(s, pool)
        .then(() => navigate(s, miningLocation, 'starting mine loop'))
        .then(() => survey(s, pool))
        .then(() => mineLoop(s, contractTradeSymbol, pool))
        .then(() => sellLoop(s, pool))
        .catch(console.error)
        .finally(async () => {
          await releaseShip(s, pool)
        })
    );
    if (allSurveyorsPromises.length) {
      allPromises.push(...allSurveyorsPromises);
    }

    const allDeliverersPromises = availableDeliverers.map((s) =>
      updateShipIsActive(s, pool)
        .then(() => navigate(s, miningLocation, 'starting mine loop'))
        .then(() => survey(s, pool))
        .then(() => mineLoop(s, contractTradeSymbol, pool))
        .then(() => deliveryLoop(s, contractData, pool))
        .then(() => sellLoop(s, pool))
        .catch(console.error)
        .finally(async () => {
          await releaseShip(s, pool)
        })
    );
    if (allDeliverersPromises.length) {
      allPromises.push(...allDeliverersPromises);
    }

    const allMinersPromises = availableMiners.map((s) =>
      updateShipIsActive(s, pool)
        .then(() => navigate(s, miningLocation, 'starting mine loop'))
        .then(() => mineLoop(s, contractTradeSymbol, pool))
        .then(() => sellLoop(s, pool))
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

const deliveryLoop = async (shipSymbol, contractData = {}) => {
  // If this ship has any of the contract delivery item, deliver it to the contract location
  const { tradeSymbol, destinationSymbol, unitsRequired, unitsFulfilled } = contractData.terms.deliver[0];
  if (tradeSymbol) {
    const { cargo: { inventory } } = await api.ship(shipSymbol);
    const contractInventory = inventory.find(({ symbol }) => symbol === tradeSymbol);
    if (contractInventory) {
      const { units } = Math.min(contractInventory.units, unitsRequired - unitsFulfilled);
      await navigate(shipSymbol, destinationSymbol, 'to deliver on contract');
      await api.post(`/my/contracts/${contractData.id}/deliver`, {
        shipSymbol,
        tradeSymbol,
        units,
      })
    }
  }
}

const mineLoop = async (shipSymbol, contract = {}, pool) => {
  console.log(shipSymbol, 'Begin mine loop');
  const cooldownResponse = await api.cooldown(shipSymbol);
  console.log(shipSymbol, 'Mine loop cooldown', cooldownResponse ? cooldownResponse.remainingSeconds : 'null');
  if (cooldownResponse && cooldownResponse.remainingSeconds > 0) {
    await timer(cooldownResponse.remainingSeconds + 1);
  }

  // Not sure why I have to check if the ship is in transit
  var shipIsInTransit = true;
  while (shipIsInTransit) {
    const shipData = await api.ship(shipSymbol);
    shipIsInTransit = shipData.nav.status === 'IN_TRANSIT';
    if (shipIsInTransit) {
      const { arrival } = shipData.nav.route;
      const secondsToWait = (Date.parse(arrival) - Date.now() / 1000);
      if (isNumber(secondsToWait)) {
        await timer(secondsToWait + 1);
      }
    }
  }

  await navigate(shipSymbol, miningLocation, 'to mine');
  await api.orbit(shipSymbol);

  await extractUntilFull(shipSymbol, contract, pool);
}

const sellLoop = async (shipSymbol, pool) => {

  // Get where to take the cargo
  const targetWaypointSymbol = await getMostPofitableTrip(shipSymbol, pool);

  await navigate(shipSymbol, targetWaypointSymbol, 'to sell resources');
  await api.dock(shipSymbol);

  const profit = await sellAll(shipSymbol, true);

  console.log('Mining profit:', profit);
}

main()
  .catch(console.error)
  .finally(() => {
    console.log('close DB pool');
    pool.end();
  });