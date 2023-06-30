require('dotenv').config();
const {
  get,
} = require('./api');
const {
  endPool,
  fetchConnectionFromPool,
} = require('./databaseUtils');

// Find out the most profitable trip to take from any marketplace in this system
// returns:
/*
{
  sourceWaypointSymbol: "X1-YU85-81074E",
  targetWaypointSymbol: "X1-CQ5-51743B",
  totalProfit: 5040,
  transactions: [
    {
      symbol: "PLATINUM",
      howManyToBuy: 30,
    },
  ],
}
*/
const getMostprofitableTripFromSystem = async (shipSymbol, sourceSystemSymbol) => {
  // Initial information
  const ship = await get('/my/ships/' + shipSymbol);
  if (!sourceSystemSymbol) {
    sourceSystemSymbol = ship.nav.systemSymbol;
  }

  // Get all the marketplaces in the system
  const waypointData = await get(`/systems/${sourceSystemSymbol}/waypoints`);
  const waypointsWithMarketplaces = waypointData.filter(({ traits }) =>
    traits.some(({ symbol }) => symbol === 'MARKETPLACE'))
    .map(({ symbol }) => symbol);

  // Find the best trip from each of those waypoints with marketplaces
  // Use reduce to avoid overloading the database pool
  const bestTripFromEachWaypoint = await waypointsWithMarketplaces.reduce(async (prevListPromise, waypointSymbol) => {
    const prevList = await prevListPromise;
    const bestTrip = await getMostprofitableTripFromWaypoint(ship, waypointSymbol);
    if (bestTrip.waypointSymbol && bestTrip.transactions) {
      prevList.push({
        sourceWaypointSymbol: waypointSymbol,
        targetWaypointSymbol: bestTrip.waypointSymbol,
        totalProfit: bestTrip.totalProfit,
        transactions: bestTrip.transactions,
      });
    }
    return prevList;
  }, Promise.resolve([]));

  if (bestTripFromEachWaypoint.length === 0) {
    // No profitable trips from this waypoint
    return;
  }
  const bestTripFromAnyWaypointInSystem = bestTripFromEachWaypoint.reduce((prevBest, oneTrip) =>
    oneTrip.totalProfit > prevBest.totalProfit ? oneTrip : prevBest
  );

  return bestTripFromAnyWaypointInSystem;
}

// Find out the most profitable one destination sales trip to take
// Default is from the ship's curernt waypoint
const getMostprofitableTripFromWaypoint = async (ship, sourceWaypointSymbol) => {
  // Initial information
  if (!ship.cargo || !ship.nav || !sourceWaypointSymbol) {
    ship = await get('/my/ships/' + ship.symbol);
  }
  if (!sourceWaypointSymbol) {
    sourceWaypointSymbol = ship.nav.waypointSymbol;
  }
  const { capacity, units: currentlyFilled } = ship.cargo;
  const availableCargoSpace = capacity - currentlyFilled;
  // const availableCargoSpace = 60; // testing
  // const sourceWaypointSymbol = 'X1-CQ5-51743B'; // testing

  let db;
  try {
    db = await fetchConnectionFromPool();
    const targetWaypointsQuery = `select distinct waypointSymbol from marketplaceData where waypointSymbol != "${sourceWaypointSymbol}"`;
    const targetWaypoints = (await db.query(targetWaypointsQuery)).map(({ waypointSymbol }) => waypointSymbol);
    const endpointProfitDataPromises = targetWaypoints.map(
      (targetWaypointSymbol) => getProfitableCargoToWaypoint(sourceWaypointSymbol, targetWaypointSymbol)
    );

    // Example:
    /*
[
  {
    waypointSymbol: "X1-DD46-66813E",
    trades: [
      {
        symbol: "SHIP_PLATING",
        tradeVolume: 10,
        purchasePrice: 359,
        sellPrice: 376,
        profitPerItem: 17,
      },
    ],
  },
  {
    waypointSymbol: "X1-YU85-99640B",
    trades: [
      {
        symbol: "FUEL",
        tradeVolume: 1000,
        purchasePrice: 122,
        sellPrice: 123,
        profitPerItem: 1,
      },
    ],
  },
]
    */
    const endpointProfitData = (await Promise.all(endpointProfitDataPromises))
      // Filter out routes with no profitable transactions
      .filter(({ trades }) => trades.length > 0);

    // Calculate total profit for the trip
    const tripProfitData = endpointProfitData.map(({ waypointSymbol, trades }) => {
      var remainingCargoSpace = availableCargoSpace;
      var totalProfit = 0;
      const sortedTrades = trades.sort(tradeComparerByProfitPerItem);
      const transactions = sortedTrades.reduce((prevTrades, oneTrade) => {
        const { symbol, tradeVolume, profitPerItem } = oneTrade;
        var howManyToBuy = 0;
        var buyThisTransaction = 0;
        while (remainingCargoSpace > 0) {
          buyThisTransaction = Math.min(remainingCargoSpace, tradeVolume);
          totalProfit += buyThisTransaction * profitPerItem;
          remainingCargoSpace -= buyThisTransaction;
          howManyToBuy += buyThisTransaction;
        }
        if (howManyToBuy > 0) {
          prevTrades.push({ symbol, howManyToBuy });
        }
        return prevTrades;
      }, []);
      return {
        waypointSymbol,
        totalProfit,
        transactions,
      };
    });

    // Example:
    /*
    [{
      waypointSymbol: "X1-YU85-99640B",
      totalProfit: 420,
      transactions: [
        {
          symbol: "FUEL",
          howManyToBuy: 60,
        },
      ],
    }]
    */
    // If nothing makes a profit
    if (endpointProfitData.length === 0) {
      return {};
    }
    const bestTrip = tripProfitData.reduce((prevBest, current) => {
      if (current.totalProfit > prevBest.totalProfit) {
        return current;
      }
      return prevBest;
    });
    return bestTrip.totalProfit > 0 ? bestTrip : {};
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

function tradeComparerByProfitPerItem(a, b) {
  if (a.profitPerItem < b.profitPerItem) {
    return -1;
  }
  if (a.profitPerItem > b.profitPerItem) {
    return 1;
  }
  // a must be equal to b
  return 0;
}

const getProfitableCargoToWaypoint = async (sourceWaypointSymbol, targetWaypointSymbol) => {
  let db;
  try {
    db = await fetchConnectionFromPool();

    // What can we buy at this source waypoint?
    // Get symbol, tradeVolume, and purchasePrice
    const buyingQuery = `select symbol, tradeVolume, purchasePrice
      from marketplaceData where waypointSymbol = "${sourceWaypointSymbol}"`;
    // [{symbol, tradeVolume, purchasePrice}]
    const dataAboutWhatWeCanBuy = await db.query(buyingQuery);
    const symbolsWeCanBuy = dataAboutWhatWeCanBuy.map(({ symbol }) => symbol);

    // For the target waypoint, get what can we sell and for how much
    // Should this be a table join?
    const sellingQuery = `select symbol, sellPrice
      from marketplaceData where waypointSymbol = "${targetWaypointSymbol}" and
      symbol in (${symbolsWeCanBuy.map((s) => `"${s}"`).join(',')})`;
    // [{symbol, sellPrice}]
    const dataAboutWhatWeCanSell = (await db.query(sellingQuery))
      .filter(({ symbol: buySymbol }) => symbolsWeCanBuy.includes(buySymbol));
    const symbolsWeCanSell = dataAboutWhatWeCanSell.map(({ symbol }) => symbol);

    // The list of items that are both for sale at the source and for buy at the destination
    const symbolsWeCareAbout = symbolsWeCanBuy.filter(( buySymbol ) =>
      symbolsWeCanSell.includes(buySymbol)
    );

    // Join buy and sell data
    // [{ symbol, tradeVolume, purchasePrice, sellPrice, profitPerItem }]
    const joinedSalesData = symbolsWeCareAbout.map((symbol) => {
      const { tradeVolume, purchasePrice } = dataAboutWhatWeCanBuy.find(({ symbol: buySymbol }) => symbol === buySymbol);
      const { sellPrice } = dataAboutWhatWeCanSell.find(({ symbol: sellSymbol }) => sellSymbol === symbol);
      const profitPerItem = sellPrice > 0 ? sellPrice - purchasePrice : 0;
      return { symbol, tradeVolume, purchasePrice, sellPrice, profitPerItem };
    })
      // Filter to what's profitable
      .filter(({ profitPerItem }) => profitPerItem > 0);

    return {
      waypointSymbol: targetWaypointSymbol,
      trades: joinedSalesData,
    };
  } catch(error) {
    console.log(error);
  } finally {
    db.release();
  }
}

module.exports = {
  getMostprofitableTripFromWaypoint,
  getMostprofitableTripFromSystem,
};

const test = async () => {
  // const bestTrip = await getMostprofitableTripFromWaypoint({ symbol: process.env.ACTIVE_SHIP},  'X1-YU85-99640B');
  // return bestTrip;
  const bestTrip = await getMostprofitableTripFromSystem(process.env.ACTIVE_SHIP);
  return bestTrip;
}
// test()
//   .then(endPool);