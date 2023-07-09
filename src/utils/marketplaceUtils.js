require('dotenv').config();
const { getPool } = require('./databaseUtils');
const { get, post } = require('./api');

const buy = async (shipSymbol, tradeSymbol, units) => {
  // Get the marketplace data

  const ship = await get(`/my/ships/${shipSymbol}`);
  const marketplaceData = await get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}/market`);
  const { tradeGoods } = marketplaceData;
  const { tradeVolume } = tradeGoods.find(({ symbol }) => symbol === tradeSymbol);
  var unitsLeft = units;
  var totalCost = 0;

  while (unitsLeft > 0) {
    const buyThisTransaction = Math.min(unitsLeft, tradeVolume);
    const { transaction } = await post(`/my/ships/${shipSymbol}/purchase`, {
      symbol: tradeSymbol,
      units: buyThisTransaction,
    });
    totalCost += transaction.totalPrice;
    unitsLeft -= buyThisTransaction;
  }
  return totalCost;
}

const updateMarketplaceData = async (systemSymbol, waypointSymbol, tradeGoods) => {
  const pool = getPool();
  let db;
  try {
    db = await pool.getConnection();
    await db.beginTransaction();
    await tradeGoods.reduce(async (prevPromise, { symbol, tradeVolume, supply, purchasePrice, sellPrice }) => {
      await prevPromise;
      return db.query(`REPLACE INTO marketplaceData (
          systemSymbol, waypointSymbol, symbol, tradeVolume, supply, purchasePrice, sellPrice, updateTime
        )
        VALUES (
          "${systemSymbol}", "${waypointSymbol}", "${symbol}", "${tradeVolume}", "${supply}", "${purchasePrice}", "${sellPrice}", "${new Date()}"
        );`)
      }, Promise.resolve());
    await db.commit();
  } catch (error) {
    console.log(error);
  } finally {
    if (db) {
      db.release();
    }
  }
  pool.end();
  console.log('Updated marketplace data for', waypointSymbol);
}

module.exports = {
  updateMarketplaceData,
  buy,
}
