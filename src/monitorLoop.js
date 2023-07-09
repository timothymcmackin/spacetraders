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
const { navigate } = require('./utils/navigationUtils');
const {
  timer,
} = require('./utils/utils');

const pool = getPool();

const main = async () => {

  var globalOrders = await getGlobalOrders(pool);

  while(globalOrders.includes('monitor')) {
    console.log('Monitor main loop');
    await restartInactiveShips(10, ['SATELLITE'], pool);
    const availableMonitors = await getShipsByOrders('monitor', pool);

    const allMonitors = await availableMonitors.map((s) =>
      updateShipIsActive(s, pool)
        .then(() => s)
    );

    if (allMonitors.length > 0) {
      await monitorAll(availableMonitors, pool)
        .finally(() =>
          Promise.all(availableMonitors.map((s) =>
            releaseShip(s, pool)
          ))
        );
    }

    await timer(30);
    globalOrders = await getGlobalOrders(pool);
  }
}

const monitorAll = async (allMonitorSymbols, pool) => {
  // Assume that all monitors are in the same system
  const oneMonitor = await api.ship(allMonitorSymbols[0]);
  const { nav: { systemSymbol } } = oneMonitor;
  const waypointData = await api.waypoints(systemSymbol);
  const waypointsWithMarketplaces = waypointData
    .filter(({ traits }) =>
      traits.some(({ symbol }) => symbol === 'MARKETPLACE')
    )
    // Filter out main mining location
    .filter(({ symbol }) => symbol !== 'X1-QM77-50715F')
    .map(({ symbol }) => symbol);

  var remainingWaypoints = [...waypointsWithMarketplaces];
  var availableShips = [...allMonitorSymbols];
  var navPromises = [];

  while (remainingWaypoints.length > 0) {
    if (availableShips.length > 0) {
      const shipToSend = availableShips.shift();
      navPromises.push(
        navigate(shipToSend, remainingWaypoints.shift(), 'monitoring marketplace')
          .then(() => availableShips.push(shipToSend))
      )
    }

    if (remainingWaypoints.length > 0) {
      await timer(30);
    }
  }
  await Promise.all(navPromises);
}

main()
  .catch(console.error)
  .finally(() => {
    console.log('close DB pool');
    pool.end();
  });