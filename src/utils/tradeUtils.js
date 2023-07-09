require('dotenv').config();
const api = require('./api');
// const { getPool } = require('./databaseUtils');

// Given a ship and its cargo, get the most profitable trip
// Based on marketplace data in the database

// Ignore marketplace data that's more than 2 hours old
const maxAgeInHours = 2;

const getMostPofitableTrip = async (shipSymbol, pool) => {
  const ship = await api.ship(shipSymbol);
  let db;
  try {
    db = await pool.getConnection();
    // get marketplaceData for waypoints in the same system
    const marketplaceDataUnfiltered = await db.query(`SELECT waypointSymbol, symbol, tradeVolume, sellPrice, updateTime
      FROM marketplaceData
      WHERE systemSymbol = "${ship.nav.systemSymbol}"`);

    // Filter out old price reports
    const now = new Date();
    const marketplaceData = marketplaceDataUnfiltered.filter(({ updateTime }) => {
      const diffInMs = now - Date.parse(updateTime);
      const diffInHours = diffInMs / (1000 * 60 * 60);
      return diffInHours <= maxAgeInHours;
    });

    /// List of waypoints we could go to
    const potentialWaypointSymbols = marketplaceData.reduce((waypointList, { waypointSymbol }) => {
      if (!waypointList.includes(waypointSymbol)) {
        waypointList.push(waypointSymbol);
      }
      return waypointList;
    }, []);

    const profitPerWaypoint = potentialWaypointSymbols.map((s) => ({
      waypointSymbol: s,
      profit: getTotalProfitToWaypoint(s, ship.cargo.inventory, marketplaceData),
    }));

    const mostProfit = Math.max(...profitPerWaypoint.map(({ profit }) => profit));
    const mostProfitableWaypointSymbol = profitPerWaypoint.find(({ profit }) => profit === mostProfit).waypointSymbol;
    return mostProfitableWaypointSymbol;
  } catch (error) {
    console.log(error);
  } finally {
    db.release();
  }
}

const getTotalProfitToWaypoint = (waypointSymbol, inventory, marketplaceData) =>
  inventory.reduce((total, { symbol, units }) => {
    const saleData = marketplaceData.find(({ waypointSymbol: w, symbol: s }) =>
      w === waypointSymbol && s === symbol
    );
    if (saleData) {
      total += units * saleData.sellPrice;
    }
    return total;
  }, 0);

module.exports = {
  getMostPofitableTrip,
}

// const myPool = getPool();
// getMostPofitableTrip('KITE-5', myPool)
//   .finally(() => myPool.end());
