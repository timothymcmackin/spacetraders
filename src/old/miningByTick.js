require('dotenv').config();
const fs = require('fs');
const {
  post,
  get,
  contractCacheFileName,
  navigate,
  sellAll,
  travelToNearestMarketplace,
} = require('./utils');
const {
  getAvailableMiningShips,
  controlShip,
  updateShipIsActive,
  releaseShip,
  restartInactiveShips,
  endPool,
} = require('./utils/databaseUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

/*
I'm intending this program to be run regularly as part of a cron job.
It checks for a current contract and if there is one, it sends mining ships to mine.
*/

async function main() {
  // await test();
  // Flush ships that have been inactive for a while because they are probably the result of a crash.
  await restartInactiveShips(10, 'EXCAVATOR');

  // To conserve rate limit, cache contract
  var procurementContract;
  try {
    procurementContract = require(contractCacheFileName);
  } catch (error) {
    // Get mining contract status
    const allContracts = await get('/my/contracts');
    procurementContract = allContracts.find(({ type }) => type === 'PROCUREMENT');
    if (procurementContract) {
      // Cache contract
      await fs.promises.writeFile(contractCacheFileName, JSON.stringify(procurementContract, null, 2));
    }
  }

  // // Limiting miners for debugging
  // const controlledMiners = ['PINCKNEY-3'];
  // await controlShip(controlledMiners[0]);

  const availableMiners = await getAvailableMiningShips();
  if (availableMiners.length === 0) {
    console.log('No idle miners');
    process.exit(0);
  }
  const controlledMiners = await Promise.all(availableMiners.filter(async (symbol) => await controlShip(symbol)));

  var startupPromises = [];
  await controlledMiners.reduce(async (prevPromise, symbol) => {
    await prevPromise;
    startupPromises.push(
      commandMiningShip(symbol, procurementContract)
        .catch((err) => console.log(symbol, err))
        .finally(async () => releaseShip(symbol))
      );
    return timer(5);
  }, Promise.resolve());

  await Promise.all(controlledMiners.map((symbol) =>
    commandMiningShip(symbol, procurementContract)
      .catch((err) => console.log(symbol, err))
      .finally(async () => releaseShip(symbol))
    ));
  endPool();
}

// Mine, deliver, sell loop
const mineDeliverSell = async (symbol, procurementContract) => {
  updateShipIsActive(symbol);
  // Update ship data
  ship = await get(`/my/ships/${symbol}`);

  // Does the ship have capacity?

  // Check if the ship is currently at a mining location
  var currentSystem = await get(`/systems/${ship.nav.systemSymbol}`);
  var currentWaypoint = currentSystem.waypoints.find((oneWaypoint) => oneWaypoint.symbol === ship.nav.waypointSymbol);

  // Mining loop
  var full = false;
  const startingCargo = await get(`/my/ships/${ship.symbol}/cargo`);
  if (startingCargo.units === startingCargo.capacity) {
    full = true;
  }
  if (!full) {
    if (currentWaypoint && currentWaypoint.type === 'ASTEROID_FIELD') {
      // We're good to mine
    } else {
      // Find an asteroid field and go there
      const { symbol: asteroidFieldSymbol } = currentSystem.waypoints.find(({ type }) => type === 'ASTEROID_FIELD');
      // TODO what if there's no asteroid field here?
      await navigate(ship, asteroidFieldSymbol, 'to go to an asteroid field');
    }
    await post(`/my/ships/${ship.symbol}/orbit`);
  }
  while (!full) {
    const cooldown = await get(`/my/ships/${ship.symbol}/cooldown`);
    if (cooldown) {
      await timer(cooldown.remainingSeconds + 1 || 0);
    }
    console.log(ship.symbol, 'extract');
    var result = await post(`/my/ships/${ship.symbol}/extract`);
    if (!result) {
      // Not sure what's causing this error
      await timer(100);
      result = await post(`/my/ships/${ship.symbol}/extract`);
    } else if (result.cargo && result.cargo.units === result.cargo.capacity) {
      full = true;
    }
  }

  // Do we have any of the target material?
  if (procurementContract) {
    const { inventory } = await get(`/my/ships/${ship.symbol}/cargo`);
    const targetMaterial = procurementContract.contract.terms.deliver[0].tradeSymbol;
    if (inventory.some(({ symbol: cargoSymbol, units }) =>
      units > 0 && cargoSymbol === targetMaterial
    )) {
      // How much do we have?
      const targetMaterialCargo = inventory.find(({ symbol: cargoSymbol }) => cargoSymbol === targetMaterial);
      const quantity = targetMaterialCargo.units;
      // Go to the contract location
      await navigate(ship, procurementContract.contract.terms.deliver[0].destinationSymbol, 'to deliver on contract');
      // Deliver the contract materials
      const updatedContract = await post(`/my/contracts/${procurementContract.contract.id}/deliver`, {
        shipSymbol: ship.symbol,
        tradeSymbol: targetMaterial,
        units: quantity,
      });
      console.log(ship.symbol, 'delivered', quantity, 'of', targetMaterial);

      if (updatedContract.contract.terms.deliver[0].unitsRequired <= 0) {
        console.log(ship.symbol, 'completed contract');
        // No current way to get a new contract
        await fs.promises.writeFile(contractCacheFileName, '{}', 'utf8');
      } else {
        await fs.promises.writeFile(contractCacheFileName, JSON.stringify(updatedContract, null, 2));
      }

    } else {
      console.log(ship.symbol, 'did a mining loop but got no', targetMaterial);
    }
  }

  // Sell off the rest
  await post(`/my/ships/${ship.symbol}/orbit`);

  await travelToNearestMarketplace(ship.symbol);

  await sellAll(ship.symbol, true);

  console.log(ship.symbol, 'completed mining loop')
  // Mining loop completed
}

async function commandMiningShip(symbol, procurementContract) {
  console.log(symbol, 'starting mining');
  // while (true) await mineDeliverSell(symbol, procurementContract);
  await mineDeliverSell(symbol, procurementContract);
}

main()
  .catch(err => {
    console.error(err);
  });
