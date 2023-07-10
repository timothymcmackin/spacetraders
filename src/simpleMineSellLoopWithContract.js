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
  extract,
} = require('./utils/utils');
const { navigate } = require('./utils/navigationUtils');
const { isNumber } = require('lodash');

const pool = getPool();

const miningLocation = 'X1-QM77-50715F';

const main = async () => {

  var globalOrders = await getGlobalOrders(pool);

  var allPromises = [];

  while(globalOrders.includes('mineAndDeliver')) {

    await restartInactiveShips(10, ['COMMAND', 'EXCAVATOR'], pool);

    const ordersToManageInThisScript = ['deliver', 'mine', 'survey'];
    let allShipsToManage = [];
    // Get all ships that have orders
    let db;
    try {
      db = await pool.getConnection();
      const allShipsWithOrders = (await db.query(`SELECT symbol, orders FROM ships
        WHERE orders IS NOT NULL AND lastActive IS NULL`))
          .map(({ symbol, orders: ordersString }) => ({
            symbol,
            orders: ordersString.split(','),
          }));
      // Filter to the orders we're managing in this file
      allShipsToManage = allShipsWithOrders.filter(({ orders }) =>
        ordersToManageInThisScript.some((oneOrder) => orders.includes(oneOrder))
      );
    } catch (error) {
      console.log(error);
    } finally {
      db.release();
    }

    // Get contract info
    const contractData = (await api.get(`/my/contracts`))[0];
    var contractTradeSymbol;
    if (contractData) {
      contractId = contractData.id;
      const { unitsRequired, unitsFulfilled } = contractData.terms.deliver[0];
      contractTradeSymbol = unitsRequired > unitsFulfilled ? contractData.terms.deliver[0].tradeSymbol : null;
    }

    // Get promises that run the ships' orders
    if (allShipsToManage.length > 0) {

      const newShipPomises = allShipsToManage.map(({ symbol: shipSymbol, orders }) =>
        shipOrdersLoop(shipSymbol , orders, contractData, contractTradeSymbol, miningLocation, pool)
          .catch(console.error)
          .finally(() => releaseShip(shipSymbol, pool))
      );
      allPromises.push(...newShipPomises);

    }

    await timer(30);
    globalOrders = await getGlobalOrders(pool);
  }
  // After global orders change, wait for everyone to finish their task
  // before closing down
  await Promise.all(allPromises);

}

// Run the ship's orders
const shipOrdersLoop = async (shipSymbol, orders, contractData, contractTradeSymbol, miningLocation, pool) => {
  // Mark ship as active
  await updateShipIsActive(shipSymbol, pool);
  // Deliver cargo to contract
  if (orders.includes('deliver')) {
    await deliveryLoop(shipSymbol, contractData, pool)
  }
  // Survey mining location
  if (orders.includes('survey')) {
    await navigate(shipSymbol, miningLocation, 'starting survey loop');
    await survey(shipSymbol, contractTradeSymbol, pool);
  }
  // Mine resources
  if (orders.includes('mine')) {
    await navigate(shipSymbol, miningLocation, 'starting mine loop');
    await mineLoop(shipSymbol, contractTradeSymbol, pool);
  }
  // Deliver again
  if (orders.includes('deliver')) {
    await deliveryLoop(shipSymbol, contractData, pool)
  }
  // Sell what's left
  await sellLoop(shipSymbol, pool);
  await navigate(shipSymbol, miningLocation, 'return to mine location');
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
    await api.dock(shipSymbol);
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
      const units = Math.min(contractInventory.units, unitsRequired - unitsFulfilled);
      await navigate(shipSymbol, destinationSymbol, 'to deliver on contract');
      await api.dock(shipSymbol);
      await api.post(`/my/contracts/${contractData.id}/deliver`, {
        shipSymbol,
        tradeSymbol,
        units,
      });
      await api.orbit(shipSymbol);
    }
  }
}

const mineLoop = async (shipSymbol, contractTradeSymbol, pool) => {
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

  // Get this ship's orders
  let db;
  let orders;
  try {
    db = await pool.getConnection();
    orders = (await db.query(`SELECT orders from ships
      WHERE symbol = "${shipSymbol}"`))[0].orders.split(',');
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }

  var ship = await api.ship(shipSymbol);
  var remainingCapacity = ship.cargo.capacity - ship.cargo.units;
  while (remainingCapacity > 0) {
    const extractResponse = await extract(shipSymbol, contractTradeSymbol, pool);
    ship = await api.ship(shipSymbol);
    remainingCapacity = ship.cargo.capacity - ship.cargo.units;

    // If this is NOT a delivery ship, transfer contracted cargo to a delivery ship
    if (!orders.includes('deliver')) {
      await transferToDelivery(shipSymbol, contractTradeSymbol, pool);
    }

    if (remainingCapacity > 0) {
      await timer(extractResponse.cooldown.remainingSeconds || 0 + 1);
    }
  }
}

const transferToDelivery = async (shipSymbol, contractTradeSymbol, pool) => {
  // Transfer cargo to delivery ship
  // Do I have any of the contract delivery symbol?
  const ship = await api.ship(shipSymbol);
  const { cargo: { inventory } } = ship;
  const contractInventory = inventory.find(({ symbol }) => symbol === contractTradeSymbol);
  if (contractInventory) {

    let db;
    try {
      db = await pool.getConnection();
      // Wait a little while for a delivery ship
      var numberOfTimesToWait = 5;
      var delaySeconds = 30;
      var deliveryShipsHere = [];
      while (deliveryShipsHere.length === 0 && numberOfTimesToWait > 0) {
        numberOfTimesToWait--;
        // Is there a delivery ship here?
        const deliveryShipSymbols = (await db.query(`select symbol from ships where orders like "%deliver%"`))
          .map(({ symbol }) => symbol);
        deliveryShipsHere = await deliveryShipSymbols.reduce(async (prevListPromise, s) => {
          var prevList = await prevListPromise;
          const deliveryShipData = await api.ship(s);
          if (deliveryShipData?.nav?.waypointSymbol === ship.nav.waypointSymbol) {
            prevList.push(s);
          }
          return prevList;
        }, []);
        if (deliveryShipsHere.length === 0) {
          await timer(delaySeconds);
        }
      }

      if (deliveryShipsHere.length > 0) {
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
    } catch (error) {
      console.log(error);
    } finally {
      db.release();
    }

  }
}

const sellLoop = async (shipSymbol, pool) => {

  // Get where to take the cargo
  const targetWaypointSymbol = await getMostPofitableTrip(shipSymbol, pool);

  if (targetWaypointSymbol) {
    await navigate(shipSymbol, targetWaypointSymbol, 'to sell resources');
    await api.dock(shipSymbol);
  }

  const profit = await sellAll(shipSymbol, true);

  console.log('Mining profit:', profit);
}

main()
  .catch(console.error)
  .finally(() => {
    console.log('close DB pool');
    pool.end();
  });