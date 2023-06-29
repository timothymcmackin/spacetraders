require('dotenv').config();
const {
  get,
} = require('./api');
const {
  endPool,
  fetchConnectionFromPool,
} = require('./databaseUtils');

// Find out the most profitable one destination sales trip to take
const getMostprofitableTrip = async (ship) => {
  if (!ship.cargo || !ship.nav) {
    ship = await get('/my/ships/' + ship.symbol);
  }
  const { waypointSymbol: sourceWaypointSymbol } = ship.nav;
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
      var remainingCargo = availableCargoSpace;
      var totalProfit = 0;
      const sortedTrades = trades.sort(tradeComparerByProfitPerItem);
      const transactions = sortedTrades.reduce((prevTrades, oneTrade) => {
        const { symbol, tradeVolume, profitPerItem } = oneTrade;
        // TODO buy multiple rounds?; price doesn't change that much
        const howManyToBuy = Math.min(remainingCargo, tradeVolume);
        totalProfit += howManyToBuy * profitPerItem;
        remainingCargo -= howManyToBuy;
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

modole.exports = {
  getMostprofitableTrip,
};