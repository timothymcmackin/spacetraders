
const fs = require('fs');
const path = require('path');
const {
  log,
  post,
  get,
  timer,
  miningShipStatusFolder,
  shipCacheFileName,
  contractCacheFileName,
  navigate,
} = require('./utils');
/*
I'm intending this program to be run regularly as part of a cron job.
It checks for a current contract and if there is one, it sends mining ships to mine.
*/

async function main() {
  // Flush ships that have been inactive for a while because they are probably the result of a crash
  const activeShipSymbols = await fs.promises.readdir(miningShipStatusFolder);
  const now = new Date();
  const checkShipPromises = activeShipSymbols.map(async (oneFile) => {
    // If the file is older than 30 minutes, wipe it
    const fileContents = fs.promises.readFile(path.resolve(miningShipStatusFolder, oneFile), 'utf8');
    const lastActiveDate = Date.parse(fileContents);
    const diffTime = Math.abs(lastActiveDate - now);
    const diffMinutes = Math.ceil(diffTime / (1000 * 60));
    if (diffMinutes >= 30) {
      return fs.promises.unlink(path.resolve(miningShipStatusFolder, oneFile));
    }
  });
  await Promise.all(checkShipPromises);

  // To conserve rate limit, cache ships and contracts
  var ships;
  try {
    ships = require(shipCacheFileName);
  } catch (error) {
    // Get ship status
    ships = await get('/my/ships');
    await fs.promises.writeFile(shipCacheFileName, JSON.stringify(ships, null, 2));
  }
  var procurementContract;
  try {
    procurementContract = require(contractCacheFileName);
  } catch (error) {
    // Get mining contract status
    const allContracts = await get('/my/contracts');
    procurementContract = allContracts.find(({ type }) => type === 'PROCUREMENT');
    await fs.promises.writeFile(contractCacheFileName, JSON.stringify(procurementContract, null, 2));
  }

  // Don't make API requests if all ships are in use
  // Get the list of ships that are currently under management by this program
  const managedMiningships = await fs.promises.readdir(miningShipStatusFolder);
  const allMiners = ships.filter(({ registration }) => registration.role === 'EXCAVATOR');

  // If there's no file for this ship, it's available for command
  const minersToDirect = allMiners.filter(({ symbol }) => !managedMiningships.includes(symbol));
  if (minersToDirect.length === 0) {
    log('No idle miners');
    process.exit(0);
  }

  // Check status of procurement contract
  const isContractFulfulled = procurementContract.contract.fulfilled;

  // If there is an active contract
  if (!isContractFulfulled) {
    await Promise.all(minersToDirect.map((ship) =>
      commandMiningShip(ship, procurementContract)
        .catch((err) => log(ship.symbol, err))
        .finally(async () => {
          // This program is done with this ship; remove the file that indicates it as unavailable
          await fs.promises.unlink(getShipStatusFilePath(ship));
        }))
    );
  } else {
    // TODO get a new contract
    // For now, just mine
  }

  // Check if there's enough money to buy another ship

}

// Mine, deliver, sell loop
const mineDeliverSell = async (ship, procurementContract) => {
  await fs.promises.writeFile(getShipStatusFilePath(ship), new Date().toString(), 'utf8');
  // Update ship location
  ship = await get(`/my/ships/${ship.symbol}`);

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
      await timer(cooldown.remainingSeconds || 0);
    }
    log(ship.symbol, 'extract');
    const result = await post(`/my/ships/${ship.symbol}/extract`);
    if (result.cargo && result.cargo.units === result.cargo.capacity) {
      full = true;
    }
  }

  // Do we have any of the target material?
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
    await fs.promises.writeFile(contractCacheFileName, JSON.stringify(updatedContract, null, 2));
    log(ship.symbol, 'delivered', quantity, 'of', targetMaterial);
  } else {
    log(ship.symbol, 'did a mining loop but got no', targetMaterial);
  }

  await post(`/my/ships/${ship.symbol}/dock`);
  // Sell off the rest
  const { inventory: inventoryAfter } = await get(`/my/ships/${ship.symbol}/cargo`);
  if (inventoryAfter.some(({units}) => units > 0)) {
    // Sell everything
    // One at a time due to limitations in the API
    await inventoryAfter.reduce(async (prevPromise, { symbol: materialSymbol, units }) => {
      await prevPromise;
      return post(`/my/ships/${ship.symbol}/sell`, {
        symbol: materialSymbol,
        units,
      });
    }, Promise.resolve());
    log(ship.symbol, 'sold cargo');
  }

  log(ship.symbol, 'completed mining loop')
  // Mining loop completed
}

async function commandMiningShip(ship, procurementContract) {
  log(ship.symbol, 'starting mining');
  // Mark ship as being currently under control of the program
  await fs.promises.writeFile(getShipStatusFilePath(ship), new Date().toString(), 'utf8');

  await mineDeliverSell(ship, procurementContract);
}

const getShipStatusFilePath = (ship) => path.resolve(miningShipStatusFolder, ship.symbol);


main()
  .catch(err => {
    console.error(err);
  });