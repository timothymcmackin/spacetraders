require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  fetchConnectionFromPool,
  singleQuery,
  writeSurveys,
  endPool,
} = require('./databaseUtils');

const { post, get } = require('./api');

const { updateMarketplaceData } = require('./marketplaceUtils');
const { getPathToSystem } = require('./pathingUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const cacheFolder = path.resolve(__dirname, 'cache');
const contractCacheFileName = path.resolve(cacheFolder, 'contract.json');

const getSystemFromWaypoint = (waypointSymbol) => {
  const stringSplit = waypointSymbol.split('-');
  return `${stringSplit[0]}-${stringSplit[1]}`;
}

const getSystemJumpGateWaypointSymbol = async (systemSymbol) => {
  const waypointsInSystem = await get(`/systems/${systemSymbol}/waypoints`);
  const jumpgateWaypoint = waypointsInSystem.find(({ type }) => type === 'JUMP_GATE');
  if (jumpgateWaypoint) {
    return jumpgateWaypoint.symbol;
  }
}

// Create a mining survey and write it to the database
const survey = async (shipSymbol) => {
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
  await writeSurveys(surveyResponse.surveys);
}

const extract = async (shipSymbol) => {
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
  const dataWithExpiration = await singleQuery(queryString);
  const now = new Date();
  const data = dataWithExpiration.filter(({ expiration }) => {
    const expDate = Date.parse(expiration);
    return expDate > now;
  });
  if (data.length === 0) {
    // No survey found
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
  return post(`/my/ships/${shipSymbol}/extract`, {
    surveys,
  });
}

const extractUntilFull = async (shipSymbol) => {
  const ship = await get('/my/ships/' + shipSymbol);
  var remainingCapacity = ship.cargo.capacity - ship.cargo.units;
  while (remainingCapacity > 0) {
    const extractResponse = await extract(shipSymbol);
    remainingCapacity = extractResponse?.cargo.capacity - extractResponse?.cargo.units;
    if (remainingCapacity > 0) {
      await timer(extractResponse.cooldown.remainingSeconds || 0 + 1);
    }
  }
}

const jump = async (ship, systemSymbol, tableName) => {
  await post(`/my/ships/${ship.symbol}/orbit`);
  ship = await get('/my/ships/' + ship.symbol);
  if (ship.nav.systemSymbol === systemSymbol) {
    console.log('Already in system', systemSymbol);
    return;
  }

  const waypointsInSystem = await get(`/systems/${ship.nav.systemSymbol}/waypoints`);
  const jumpGateWaypoint = waypointsInSystem
    .find(({ type }) => type === 'JUMP_GATE');
  const targetWaypoint = jumpGateWaypoint.symbol;
  await navigate(ship, targetWaypoint, 'to jump gate', false);

  // Get the path of systems to jump to
  var pathOfJumps = await getPathToSystem(ship.nav.systemSymbol, systemSymbol, tableName);
  // Remove current location
  pathOfJumps.shift();
  console.log('Jump path:', pathOfJumps);

  // Jump loop
  await pathOfJumps.reduce(async (prevPromise, targetSystem) => {
    await prevPromise;

    console.log(ship.symbol, 'jumping to', targetSystem);
    const { nav, cooldown } = await post('/my/ships/' + ship.symbol + '/jump', {
      systemSymbol: targetSystem,
    });
    console.log(ship.symbol, 'travel time', cooldown.remainingSeconds + 1, 'seconds');
    await timer(cooldown.remainingSeconds + 1);
    await post(`/my/ships/${ship.symbol}/orbit`);
    console.log(ship.symbol, 'arrived after jump');

  }, Promise.resolve());

}

// Send the ship somewhere and resolve when it arrives
const navigate = async (ship, waypoint, reason = '', refuel = true, tableName) => {
  console.log(ship.symbol, 'navigating to', waypoint, reason);
  // Make sure we're in orbit
  var { nav } = await post(`/my/ships/${ship.symbol}/orbit`);

  // Are we in the right system?
  const targetSystem = getSystemFromWaypoint(waypoint);
  if (targetSystem !== nav.systemSymbol) {
    await jump(ship, targetSystem, tableName)
      .catch(err => {
        console.error('Jump pathing failed.');
        console.error(err);
      });
  }

  // Are we already there?
  if (waypoint === nav.waypointSymbol) {
    console.log(ship.symbol, 'is already at', waypoint);
    return;
  }

  var departureTime = 0;
  var arrivalTime = 0;
  await post(`/my/ships/${ship.symbol}/navigate`, {
    waypointSymbol: waypoint,
  })
    .then(async (navigationResponse) => {
      if (!navigationResponse) {
        return;
      }
      departureTime = Date.parse(navigationResponse.nav.route.departureTime);
      arrivalTime = Date.parse(navigationResponse.nav.route.arrival);

      // How long will it take?
      const waitTime = Math.ceil((arrivalTime - departureTime) / 1000 + 1);
      console.log(ship.symbol, 'travel time', waitTime, 'seconds');
      await timer(waitTime);
      console.log(ship.symbol, 'arrived');
    });

  // dock
  await post(`/my/ships/${ship.symbol}/dock`);
  //refuel
  // If we're at a jump gate, no fuel
  ship = await get('/my/ships/' + ship.symbol);
  const { type } = await get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}`);
  if (refuel && type !== 'JUMP_GATE') {
    const { transaction } = await post(`/my/ships/${ship.symbol}/refuel`);
    console.log(ship.symbol, 'fuel cost', transaction.totalPrice);
  }

  // Should be passing the system symbol to this function as well.
  // Till then:
  nav = (await get(`/my/ships/${ship.symbol}`)).nav;
  const { systemSymbol } = nav;

  // Does the waypoint have a market?
  const { traits } = await get(`/systems/${systemSymbol}/waypoints/${waypoint}`);
  if (traits.some(({ symbol }) => symbol === 'MARKETPLACE')) {
    const { tradeGoods } = await get(`/systems/${systemSymbol}/waypoints/${waypoint}/market`);
    // Maybe don't bother awaiting here and just let the promise run?
    await updateMarketplaceData(systemSymbol, waypoint, tradeGoods);
  }
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

const travelToNearestMarketplace = async (shipSymbol) => {
  const ship = await get(`/my/ships/${shipSymbol}`);
  const waypointsInSystem = await get(`/systems/${ship.nav.systemSymbol}/waypoints`);
  const waypointsWithMarketplaces = waypointsInSystem
    .filter(({ traits }) =>
      traits.some(({ symbol }) => symbol === 'MARKETPLACE')
    )
    .map(({ symbol }) => symbol);

  // Are we already there?
  if (waypointsInSystem.some(({ symbol }) => symbol === ship.nav.waypointSymbol)) {
    return;
  }

  // TODO Figure out which one to go to
  // For now, pick one at random
  const targetWaypoint = waypointsWithMarketplaces[Math.floor(Math.random() * waypointsWithMarketplaces.length)];

  await post(`/my/ships/${shipSymbol}/orbit`);
  await navigate(ship, targetWaypoint, 'nearest marketplace');
}

const initSystem = async (systemSymbol) => {
  const waypoints = await get('/systems/' + systemSymbol + '/waypoints');
  const jumpGateWaypointSymbol = waypoints.find(({ type }) => type === 'JUMP_GATE').symbol;
  await singleQuery(`REPLACE INTO systems (systemSymbol, jumpgateWaypoint)
  VALUES ("${systemSymbol}", "${jumpGateWaypointSymbol}")`);

  await waypoints.reduce(async (prevPromise, { symbol: waypointSymbol, traits }) => {
    await prevPromise;
    const hasMarketplace = traits.some(({ symbol }) => symbol === 'MARKETPLACE');
    await singleQuery(`REPLACE INTO waypoints (systemSymbol, waypointSymbol, marketplace)
    VALUES ("${systemSymbol}", "${waypointSymbol}", ${hasMarketplace})`)
  }, Promise.resolve());

}

const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

module.exports = {
  contractCacheFileName,
  navigate,
  jump,
  sellAll,
  travelToNearestMarketplace,
  getSystemFromWaypoint,
  getSystemJumpGateWaypointSymbol,
  getRandomElement,
  survey,
  extract,
  extractUntilFull,
  initSystem,
}