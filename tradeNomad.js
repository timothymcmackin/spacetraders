require('dotenv').config();
const {
  log,
  post,
  get,
  timer,
  navigate,
  sellAll,
  travelToNearestMarketplace,
} = require('./utils');
const {
  getAvailableMiningShips,
  controlShip,
  updateShipIsActive,
  releaseShip,
  restartInactiveShips,
  endPool,
  getOrders,
} = require('./databaseUtils');
const { fetchConnectionFromPool } = require('./databaseUtils');

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
        const maxDataQuery = `select max(m.sellPrice), m.waypointSymbol
          from marketplaceData as m
          inner join waypoints as w
          on m.waypointSymbol = w.waypointSymbol
          where m.symbol = "${tradeGoodSymbol}" and w.waypointSymbol != "${ship.nav.waypointSymbol}" and w.deadEnd < 1`;
        const maxData = await db.query(maxDataQuery);
        if (!maxData[0]['max(m.sellPrice)']) {
          return {
            tradeGoodSymbol,
            totalProfit: 0,
          };
        }
        const totalSalePrice = Math.min(volume, availableCargoSpace) * maxData[0]['max(m.sellPrice)'];
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
      log(error);
    } finally {
      db.release();
    }

    // Choose the most profitable route
    const whatToBuyAndDo = profitPerItem.reduce((prevBest, oneItem) => {
      return oneItem.totalProfit > prevBest.totalProfit ? oneItem : prevBest;
    });

    if (whatToBuyAndDo.totalProfit > 0) {
      console.log(`${ship.symbol} is going to buy ${whatToBuyAndDo.volume} of ${whatToBuyAndDo.tradeGoodSymbol} for a projected profit of ${whatToBuyAndDo.totalProfit}.`);

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
        const waypointDataFromDatabase = await db.query(`select waypointSymbol from waypoints where marketplace is true and waypointSymbol != ${ship.nav.waypointSymbol}`); // and deadEnd < 1
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