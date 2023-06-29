require('dotenv').config();
const {
  navigate,
  sellAll,
  travelToNearestMarketplace,
} = require('./utils/utils');
const {
  post,
  get,
} = require('./utils/api');
const {
  getAvailableMiningShips,
  controlShip,
  updateShipIsActive,
  releaseShip,
  restartInactiveShips,
  endPool,
  getOrders,
  fetchConnectionFromPool,
} = require('./utils/databaseUtils');

const timer = s => new Promise( res => setTimeout(res, s * 1000));

const nomadLoop = async (symbol) => {

  // temp
  // let newDb;
  // const ship = await get(`/my/ships/${symbol}`);
  // try {
  //   newDb = await fetchConnectionFromPool();
  //   const waypointDataTemp = await get(`/systems/${ship.nav.systemSymbol}/waypoints`);
  //   newDb.beginTransaction();
  //   for (const w of waypointDataTemp) {
  //     const hasMarketplace = w.traits.some(({symbol}) => symbol === 'MARKETPLACE');
  //     await newDb.query(`insert into waypoints (systemSymbol, waypointSymbol, deadEnd, marketplace) values ("${w.systemSymbol}", "${w.symbol}", 0, ${hasMarketplace})`);
  //   }
  //   newDb.commit();
  // } catch (error) {

  // }

  var orders = await getOrders(symbol);
  // This updates pricing database automatically, no need to do it again
  await travelToNearestMarketplace(symbol);

  while (orders === 'tradeNomad') {

    const ship = await get(`/my/ships/${symbol}`);
    var availableCargoSpace = ship.cargo.capacity - ship.cargo.units;
    await sellAll(symbol, false);
    var agent = await get('/my/agent');
    var credits = agent.credits;

    // Get what is available here
    const { tradeGoods } = await get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}/market`);

    // Get how much of each I can afford
    // returns [{ tradeGoodSymbol, volume }]
    var howMuchICanAfford = tradeGoods.map(({ symbol: tradeGoodSymbol, purchasePrice }) => ({
      tradeGoodSymbol,
      volume: Math.floor(credits / purchasePrice),
      purchasePrice,
    }));
    let db;
    let profitPerItem;
    try {
      db = await fetchConnectionFromPool();
      // Get what those things sell for elsewhere and how much profit I can make
      // returns [{ tradeGoodSymbol, volume, totalSalePrice, targetWaypoint }]
      profitPerItem = await Promise.all(howMuchICanAfford.map(async ({ tradeGoodSymbol, volume, purchasePrice }) => {
        // Get the best sale price for each item
        const maxDataQuery = `select max(sellPrice), waypointSymbol
          from marketplaceData
          where symbol = "${tradeGoodSymbol}" and waypointSymbol != "${ship.nav.waypointSymbol}"`;
        const maxData = await db.query(maxDataQuery);
        if (!maxData[0]['max(sellPrice)']) {
          return {
            tradeGoodSymbol,
            totalProfit: 0,
          };
        }
        // Get number available
        const numberAvailable = tradeGoods.find(({ symbol }) => symbol === tradeGoodSymbol).tradeVolume;
        const totalSalePrice = Math.min(volume, availableCargoSpace, numberAvailable) * maxData[0]['max(sellPrice)'];
        const volumeToBuy = Math.min(volume, availableCargoSpace);
        const totalCost = volumeToBuy * purchasePrice;
        const totalProfit = totalSalePrice - totalCost;
        return {
          tradeGoodSymbol,
          volume: volumeToBuy,
          totalSalePrice,
          totalCost,
          totalProfit,
          targetWaypoint: maxData[0]['waypointSymbol'],
        };
      }));

    } catch (error) {
      console.log(error);
    } finally {
      db.release();
    }

    // Choose the most profitable route
    const whatToBuyAndDo = profitPerItem.reduce((prevBest, oneItem) => {
      return oneItem.totalProfit > prevBest.totalProfit ? oneItem : prevBest;
    });

    if (whatToBuyAndDo.totalProfit > 0) {
      console.log(`${ship.symbol} is going to buy ${whatToBuyAndDo.volume} of ${whatToBuyAndDo.tradeGoodSymbol} and take it to ${whatToBuyAndDo.targetWaypoint} for a projected profit of ${whatToBuyAndDo.totalProfit} minus fuel cost.`);

      // Buy that many
      // Later we can try to fill all the cargo holds; feels like a reduce to me
      // console.log(profitPerItem);
      await post(`/my/ships/${ship.symbol}/dock`);
      await post(`/my/ships/${symbol}/purchase`, {
        symbol: whatToBuyAndDo.tradeGoodSymbol,
        units: whatToBuyAndDo.volume,
      });

      // Go
      await navigate(ship, whatToBuyAndDo.targetWaypoint, 'trading', false);
      await post(`/my/ships/${ship.symbol}/dock`);
      await sellAll(symbol, true);
      await post(`/my/ships/${ship.symbol}/refuel`);

      agent = await get('/my/agent');
      credits = agent.credits;
      console.log('Credits:', credits);
    } else {
      console.log('Could not find a profitable trade route. Dead end at', ship.nav.waypointSymbol);
      try {
        db = await fetchConnectionFromPool();
        const oldDeadEndCount = await db.query(`select deadEnd from waypoints where waypointSymbol = "${ship.nav.waypointSymbol}"`);
        const newDeadEndCount = 1 + oldDeadEndCount[0]['deadEnd'];
        // TODO keep waypoints table updated when we travel; not currently adding waypoints to the table when we jump to a new system
        await db.query(`update waypoints set deadEnd = ${newDeadEndCount} where waypointSymbol = "${ship.nav.waypointSymbol}"`);
      } catch (error) {
        console.log(error);
      } finally {
        db.release();
      }

      // Stuck; travel to a random waypoint with low dead end count
      let waypointSymbolsFromDb;
      try {
        db = await fetchConnectionFromPool();
        const waypointDataFromDatabase = await db.query(`select waypointSymbol from marketplaceData where waypointSymbol != ${ship.nav.waypointSymbol}`);
        waypointSymbolsFromDb = waypointDataFromDatabase.map((w) => w.waypointSymbol);
      } catch (error) {
        const waypointData = await get(`/systems/${ship.nav.systemSymbol}/waypoints`);
        waypointSymbolsFromDb = waypointData.filter(({ traits }) =>
          traits.some(({ symbol }) => symbol === 'MARKETPLACE')
        ).filter(({ symbol }) => symbol !== ship.nav.waypointSymbol)
        .map(({symbol}) => symbol);

      } finally {
        db.release();
      }

      const targetWaypoint = waypointSymbolsFromDb[Math.floor(Math.random() * waypointSymbolsFromDb.length)];
      if (targetWaypoint) {
        await navigate(ship, targetWaypoint, 'random waypoint for trading', false);
      } else {
        // Nowhere to go
        console.log('Nowhere to go.');
        console.log('waypointSymbolsFromDb:')
        console.log(JSON.stringify(waypointSymbolsFromDb, null, 2));
        return;
      }
    }

    orders = await getOrders(symbol);

  }

}


nomadLoop('CATAMOUNT-1');