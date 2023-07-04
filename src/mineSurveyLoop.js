require('dotenv').config();
const { post, get } = require('./utils/api')
const {
  navigate,
  sellAll,
  travelToNearestMarketplace,
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
    const allTradersPromise = getShipsByOrders('trade');
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

    // const activeMinersPromise = allMinersPromise.then((minerSymbols) => {
    //   if (minerSymbols && minerSymbols.length) {
    //     return minerSymbols.reduce(async (currentListPromise, oneMinerSymbol) => {
    //       const currentList = await currentListPromise;
    //       const successfullyActivatedShip = await controlShip(oneMinerSymbol);
    //       if (successfullyActivatedShip) {
    //         // Successfully marked the ship as busy in the database
    //         // So this ship is ready for use
    //         currentList.push(oneMinerSymbol);
    //       }
    //       return currentList;
    //     }, Promise.resolve([]));
    //   }
    // });

    // Send the scouts to marketplaces
    const scoutLoopPromise = scoutLoop(activeScoutsPromise, systemSymbol);

    // Send miners to mine
    // const minerLoopPromise = minerLoop(activeMinersPromise, miningLocation);

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
const minerLoop = async (activeMinersPromise, miningLocation) => {
  // TODO
}

main()
  .catch(console.error)
  .finally(endPool);
