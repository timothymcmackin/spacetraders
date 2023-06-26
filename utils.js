require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const api = axios.create({
  baseURL: 'https://api.spacetraders.io/v2/',
  timeout: 5000,
  headers: { 'Authorization': `Bearer ${process.env.SPACETRADERS_TOKEN}` },
});

const timer = s => new Promise( res => setTimeout(res, s * 1000));
const log = console.log;

const cacheFolder = path.resolve(__dirname, 'cache');
const miningShipStatusFolder = path.resolve(cacheFolder, 'miningShips');
const shipCacheFileName = path.resolve(cacheFolder, 'ships.json');
const contractCacheFileName = path.resolve(cacheFolder, 'contract.json');

// Utility functions to get rid of the data:data in every request
const get = (path) => api.get(path)
  .then(({ status, data: { data: result }}) => result);

const post = (path, body = {}) => api.post(path, body)
  .then(({ status, data: { data: result }}) => result);


// Send the ship somewhere and resolve when it arrives
const navigate = async (ship, waypoint, reason = '') => {
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
      const waitTime = (arrivalTime - departureTime) / 1000 + 1;
      log(ship.symbol, 'travel time', waitTime, 'seconds');
      await timer(waitTime);
      log(ship.symbol, 'arrived');
    });

  // dock
  await post(`/my/ships/${ship.symbol}/dock`);
  //refuel
  await post(`/my/ships/${ship.symbol}/refuel`);
}

module.exports = {
  timer,
  log,
  post,
  get,
  miningShipStatusFolder,
  shipCacheFileName,
  contractCacheFileName,
  navigate,
}