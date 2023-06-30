require('dotenv').config();
const {
  navigate,
  sellAll,
} = require('./utils/utils');
const {
  post,
  get,
} = require('./utils/api');
const {
  endPool,
  getOrders,
  getDifferentSystemJumpgateWaypoint,
} = require('./utils/databaseUtils');
const { getMostprofitableTrip, getMostprofitableTripFromSystem } = require('./utils/tradeUtils');
const { buy } = require('./utils/marketplaceUtils');


const main = async (shipSymbol) => {
  // if (!controlShip(shipSymbol)) {
  //   console.log('Failed to get control of ship', shipSymbol);
  //   return;
  // }
  const ship = await get(`/my/ships/${shipSymbol}`);
  var orders = await getOrders(shipSymbol);
  while (orders === 'tradeNomad') {
    var sourceWaypointSymbol, targetWaypointSymbol, totalProfit, transactions;
    // Catch case where there are no profitable trips from this system
    var trip;
    while (!trip) {
      trip = await getMostprofitableTripFromSystem(shipSymbol);
      if (trip) {
        sourceWaypointSymbol = trip.sourceWaypointSymbol;
        targetWaypointSymbol = trip.targetWaypointSymbol;
        totalProfit = trip.totalProfit;
        transactions = trip.transactions;
      } else {
        // Travel to another system
        const jumpGateWaypoint = await getDifferentSystemJumpgateWaypoint(ship.nav.systemSymbol);
        await navigate(ship, jumpGateWaypoint, 'to a random other system looking for a profitable trade route');
      }
    }

    // Go to source waypoint
    await navigate(ship, sourceWaypointSymbol, 'to start trade');
    await post(`/my/ships/${shipSymbol}/dock`);
    // Buy
    var totalCost = 0;
    await transactions.reduce(async (prevPromise, { symbol: tradeSymbol, howManyToBuy }) => {
      await prevPromise;
      const transactionCost = await buy(shipSymbol, tradeSymbol, howManyToBuy);
      totalCost += transactionCost;
    }, Promise.resolve());
    // console.log('Bought', totalCost, 'credits of goods.');
    await post(`/my/ships/${shipSymbol}/orbit`);

    // Go to destination
    await navigate(ship, targetWaypointSymbol);
    await post(`/my/ships/${shipSymbol}/dock`);
    const totalSalePrice = await sellAll(shipSymbol);
    console.log(`${shipSymbol} bought for ${totalCost} and sold for ${totalSalePrice} for a profit of ${totalSalePrice - totalCost}.`);
    orders = await getOrders(shipSymbol);
  }
}

main(process.env.ACTIVE_SHIP)
  .then(endPool);