require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const rateLimit = require('axios-rate-limit');
const { updateMarketplaceData } = require('./marketplaceUtils');

const api = rateLimit(axios.create({
  baseURL: 'https://api.spacetraders.io/v2/',
  timeout: 5000,
  headers: { 'Authorization': `Bearer ${process.env.SPACETRADERS_TOKEN}` },
}),
  // Limit to 1 request per second
  // https://github.com/aishek/axios-rate-limit
  { maxRPS: 1}
);

const timer = s => new Promise( res => setTimeout(res, s * 1000));
const log = console.log;

const cacheFolder = path.resolve(__dirname, 'cache');
const contractCacheFileName = path.resolve(cacheFolder, 'contract.json');

// Utility functions to get rid of the data:data in every request
const get = (path) => api.get(path)
  .then(async (response) => {
    let { status, data } = response;
    if (status === 429) {
      log('Rate limit on GET', path);
      await timer(2 * 60);
    } else if (!status.toString().startsWith('2')){
      log("ErrorCode:", response?.data?.error?.code);
      log(JSON.stringify(result.error, null, 2))
    }
    const { data: result } = data;
    return result;
  })
  .catch((error) => {
    log(JSON.stringify(error.response.data, null, 2))
  })

const post = (path, body = {}) => api.post(path, body)
  .then(async (response) => {
    let { status, data } = response;
    if (status === 429) {
      log('Rate limit on POST', path);
      await timer(2 * 60);
    } else if (status === 409 && response?.data?.error?.code === 4000) {
      // Too soon for cooldown
      const remainingCooldown = response.data.error.data.cooldown.remainingSeconds;
      await timer(remainingCooldown);
      const newResponse = await api.post(path, body);
      data = newResponse.data;
    } else if (!status.toString().startsWith('2')){
      log("ErrorCode:", response?.data?.error?.code);
      log(JSON.stringify(result.error, null, 2))
    }
    const { data: result } = data;
    return result;
  })
  .catch((error) => {
    log(JSON.stringify(error.response.data, null, 2))
  })


// Send the ship somewhere and resolve when it arrives
const navigate = async (ship, waypoint, reason = '', refuel = true) => {
  log(ship.symbol, 'navigating to', waypoint, reason);
  // Make sure we're in orbit
  await post(`/my/ships/${ship.symbol}/orbit`);

  // Maybe we're already there
  var departureTime = 0;
  var arrivalTime = 0;
  await post(`/my/ships/${ship.symbol}/navigate`, {
    waypointSymbol: waypoint,
  })
    .catch((err) => {
      // We're probably already there
      log(err);
      log(ship.symbol, 'is already at', waypoint);
    })
    .then(async (navigationResponse) => {
      if (!navigationResponse) {
        return;
      }
      departureTime = Date.parse(navigationResponse.nav.route.departureTime);
      arrivalTime = Date.parse(navigationResponse.nav.route.arrival);

      // How long will it take?
      const waitTime = Math.ceil((arrivalTime - departureTime) / 1000 + 1);
      log(ship.symbol, 'travel time', waitTime, 'seconds');
      await timer(waitTime);
      log(ship.symbol, 'arrived');
    });

  // dock
  await post(`/my/ships/${ship.symbol}/dock`);
  //refuel
  if (refuel) {
    const { transaction } = await post(`/my/ships/${ship.symbol}/refuel`);
    log(ship.symbol, 'fuel cost', transaction.totalPrice);
  }

  // Should be passing the system symbol to this function as well.
  // Till then:
  const { nav } = await get(`/my/ships/${ship.symbol}`);
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
  const { symbol, nav, cargo } = await get(`/my/ships/${shipSymbol}`);
  const { systemSymbol, waypointSymbol } = nav;
  const { inventory } = cargo;
  if (inventory.length === 0) {
    log(shipSymbol, "doesn't have anything to sell");
    return;
  }

  // Get the marketplace data
  const marketplaceData = await get(`/systems/${systemSymbol}/waypoints/${waypointSymbol}/market`);
  const { tradeGoods } = marketplaceData;
  const thingsWeCanSellHere = tradeGoods.map(({ symbol }) => symbol);

  if (inventory.some(({ units }) => units > 0)) {
    // Sell everything
    // One at a time due to limitations in the API
    await inventory.reduce(async (prevPromise, { symbol: materialSymbol, units }) => {
      await prevPromise;
      // Can we sell this here?
      if (thingsWeCanSellHere.includes(materialSymbol)) {
        return post(`/my/ships/${shipSymbol}/sell`, {
          symbol: materialSymbol,
          units,
        });
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
    log(shipSymbol, 'sold cargo');
  }
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
  await navigate(ship, targetWaypoint, 'to sell cargo');
}

module.exports = {
  timer,
  log,
  post,
  get,
  contractCacheFileName,
  navigate,
  sellAll,
  travelToNearestMarketplace,
}