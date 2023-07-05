require('dotenv').config();
const { post, get } = require('./utils/api')
const {
  navigate,
  sellAll,
  travelToNearestMarketplace,
  extractUntilFull,
  survey,
} = require('./utils/utils');
const {
  getAvailableMiningShips,
  controlShip,
  updateShipIsActive,
  releaseShip,
  restartInactiveShips,
  endPool,
  getShipsByOrders,
  getGlobalOrders,
  singleQuery,
} = require('./utils/databaseUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const loopWait = 10;
const systemSymbol = 'X1-YU85';
const miningLocation = 'X1-YU85-76885D';

const main = async () => {

  var scoutLoopPromise, mineLoopPromise, tradeLoopPromise = Promise.resolve();

  var globalOrders = (await getGlobalOrders());

  while(globalOrders.includes('mineAndTrade')) {
    // Flush ships that have been inactive for a while because they are probably the result of a crash.
    await Promise.all(['COMMAND', 'SATELLITE', 'EXCAVATOR'].map((role) =>
      // Satellites are super slow
      restartInactiveShips(20, role)
    ));

    const allMinersPromise = getShipsByOrders('mine');
    const allTradersPromise = getShipsByOrders('mineDelivery');
    const allScoutsPromise = getShipsByOrders('checkMarketplaces');

    // Mark scouts as active ships in the database
    const activeScoutsPromise = allScoutsPromise.then((scoutSymbols) => {
      // Mark available scouts as under control in the database
      if (scoutSymbols && scoutSymbols.length > 0) {
        return scoutSymbols.reduce(async (currentListPromise, oneScoutSymbol) => {
          const currentList = await currentListPromise;
          const successfullyActivatedShip = await controlShip(oneScoutSymbol);
          if (successfullyActivatedShip) {
            // Successfully marked the ship as busy in the database
            // So this ship is ready for use
            currentList.push(oneScoutSymbol);
          }
          return currentList;
        }, Promise.resolve([]));
      }
    }
    );

    // Send the scouts to marketplaces
    scoutLoopPromise = scoutLoop(activeScoutsPromise, systemSymbol);

    // Send miners to mine
    mineLoopPromise = allMinersLoop();

    // TODO send delivery ships to deliver

    await timer(loopWait);
    globalOrders = (await getGlobalOrders());
  }

  await Promise.all([scoutLoopPromise, mineLoopPromise, tradeLoopPromise]);
}

// Send the scouts around to each marketplace
// Resolve when finished
const scoutLoop = async (activeScoutsPromise, systemSymbol) => {
  var availableScouts = await activeScoutsPromise;

  // Just to be sure, but we shouldn't need this
  if (!availableScouts || availableScouts.length === 0) {
    return [];
  }

  // Get a list of marketplaces in this system
  const marketplaceWaypoints = await singleQuery(`SELECT waypointSymbol FROM waypoints
  WHERE systemSymbol = "${systemSymbol}" AND marketplace = true`);
  var marketplaceWaypointSymbols = marketplaceWaypoints.map(({ waypointSymbol }) => waypointSymbol);

  var missionPromises = [];

  while (marketplaceWaypointSymbols.length > 0) {
    if (availableScouts.length > 0 ) {
      availableScouts.forEach(oneScoutSymbol => {
        const marketplaceTarget = marketplaceWaypointSymbols.shift();
        availableScouts = availableScouts.filter((s) => s !== oneScoutSymbol);
        updateShipIsActive(oneScoutSymbol)
        missionPromises.push(sendScout(oneScoutSymbol, marketplaceTarget)
          .then((shipSymbol) => availableScouts.push(shipSymbol)));
      });
    }
    // Need this await otherwise this loop becomes blocking
    await timer(loopWait);
  }
  // Release the scouts
  // This unfortunately holds them all until all are done
  // Not sure how to release them earlier
  // Still not closing correctly
  await Promise.all(missionPromises);
  await availableScouts.reduce((prevPromise, oneScoutSymbol) =>
    prevPromise.then(() => releaseShip(oneScoutSymbol))
  , Promise.resolve());
  return availableScouts;
}

// Return scout symbol
const sendScout = async (shipSymbol, marketplaceTarget) => {
  await navigate({ symbol: shipSymbol }, marketplaceTarget);
  return shipSymbol;
}

// Send miners to mine until they are full and then transfer cargo to a waiting trader
const allMinersLoop = async () => {
  // Get initial miners
  const minerSymbols = await getShipsByOrders('mine');

  // Take control by marking them as active in the database
  var availableMiners = await minerSymbols.reduce(async (currentListPromise, oneMinerSymbol) => {
    const currentList = await currentListPromise;
    const successfullyActivatedShip = await controlShip(oneMinerSymbol);
    if (successfullyActivatedShip) {
      // Successfully marked the ship as busy in the database
      // So this ship is ready for use
      currentList.push(oneMinerSymbol);
    }
    return currentList;
  }, Promise.resolve({}));

  // Just to be sure
  if (!availableMiners || availableMiners.length === 0) {
    return [];
  }

  // Initiate a loop for each miner
  return Promise.all(availableMiners.map((oneMinerSymbol) => minerLoop(oneMinerSymbol, miningLocation)));
}

const minerLoop = async (minerSymbol, miningLocation) => {
  // Update active
  await updateShipIsActive(minerSymbol);
  // Go to miningLocation
  await navigate({ symbol: minerSymbol }, miningLocation, 'mining');
  // Mine until full
  await extractUntilFull(minerSymbol);
  await post(`/my/ships/${minerSymbol}/orbit`);
  var { units } = await get(`/my/ships/${minerSymbol}/cargo`);
  // Transfer cargo
  while (units > 0) {

    await transferLoop(minerSymbol, miningLocation);

    // If we still have cargo, wait for a cargo ship
    units = (await get(`/my/ships/${minerSymbol}/cargo`)).units;
    if (units > 0) {
      await timer(30);
    }

  }
}

const transferLoop = async (minerSymbol, miningLocation) => {

  // Get symbols of cargo ships
  const cargoShipSymbols = await getShipsByOrders('mineDelivery');
  // Are there cargo ships with capacity in the same waypoint?
  var cargoShipsAtWaypoint = await cargoShipSymbols.reduce(async (prevListPromise, oneCargoShipSymbol) => {
    const prevList = await prevListPromise;
    const { nav: { waypointSymbol }, cargo: cargoShipCargo } = await get(`/my/ships/${oneCargoShipSymbol}`);
    if (waypointSymbol === miningLocation && cargoShipCargo.capacity > cargoShipCargo.units) {
      prevList.push(oneCargoShipSymbol);
    }
    return prevList;
  }, Promise.resolve([]));

  // Find what to transfer to those cargo ships
  while (cargoShipsAtWaypoint.length > 0) {
    const currentCargoShipSymbol = cargoShipsAtWaypoint.pop();
    // Get the capacity again in case someone else is transferring cargo to it
    // But with so many awaits, we may have a race condition with another miner
    const { capacity: oneCargoShipCapacity, units: oneCargoShipUnits } = await get(`/my/ships/${currentCargoShipSymbol}/cargo`);
    var remainingCapacity = oneCargoShipCapacity - oneCargoShipUnits;
    var { inventory } = await get(`/my/ships/${minerSymbol}/cargo`);

    while (remainingCapacity > 0 && inventory.length > 0) {
      const { symbol: symbolToTransfer, units: unitsToTransfer } = inventory.shift();
      if (unitsToTransfer < remainingCapacity) {
        // We can transfer all of the item
        await post(`/my/ships/${minerSymbol}/transfer`, {
          tradeSymbol: symbolToTransfer,
          units: unitsToTransfer,
          shipSymbol: currentCargoShipSymbol,
        });
        // Deduct from the cargo ship capacity
        // TODO: may be a problem here; follow remainingCapacity to see if it's accurate
        remainingCapacity -= unitsToTransfer;
      } else {
        // We can transfer only some of the item
        await post(`/my/ships/${minerSymbol}/transfer`, {
          tradeSymbol: symbolToTransfer,
          units: remainingCapacity,
          shipSymbol: currentCargoShipSymbol,
        });
        // Update inventory instead of trying to do the math here
        inventory = (await get(`/my/ships/${minerSymbol}/cargo`)).inventory;
      }
    }

  }
}

const deliveryLoop = async (traderSymbol, miningLocation) => {
  // Go to mining location and await cargo
  // Be sure you're in orbit
  await navigate({ symbol: traderSymbol }, miningLocation);
  var { units, capacity } = await get(`/my/ships/${traderSymbol}/cargo`);
  survey(traderSymbol);
  var maxWaitCycles = 20; // Wait 20 minutes for cargo
  while (units < capacity && maxWaitCycles > 0) {
    // Wait for cargo
    updateShipIsActive(traderSymbol);
    maxWaitCycles--;
    await timer(60);
    // Update cargo
    const cargo = await get(`/my/ships/${traderSymbol}/cargo`);
    units = cargo.units;
    capacity = cargo.capacity;
  }
  var { inventory } = await get(`/my/ships/${traderSymbol}/cargo`);
  if (inventory.length === 0) {
    // Couldn't get any cargo
    return;
  }

  // TODO Calculate single trip with the best price
  // For now, just hard-code the market in this system
  // b/c the starting system has an asteroid field and a market at the same waypoint
  await post(`/my/ships/${traderSymbol}/dock`);
  await sellAll(traderSymbol, true);
  await post(`/my/ships/${traderSymbol}/orbit`);
}

deliveryLoop('KITE-1', miningLocation)
  .catch(console.error)
  .finally(endPool);
