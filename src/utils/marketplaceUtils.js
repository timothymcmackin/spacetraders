require('dotenv').config();
const { fetchConnectionFromPool } = require('./databaseUtils');

const updateMarketplaceData = async (systemSymbol, waypointSymbol, tradeGoods) => {
  let db;
  try {
    db = await fetchConnectionFromPool();
    await db.beginTransaction();
    await tradeGoods.reduce(async (prevPromise, { symbol, tradeVolume, supply, purchasePrice, sellPrice }) => {
      await prevPromise;
      return db.query(`REPLACE INTO marketplaceData (
          systemSymbol, waypointSymbol, symbol, tradeVolume, supply, purchasePrice, sellPrice
        )
        VALUES (
          "${systemSymbol}", "${waypointSymbol}", "${symbol}", "${tradeVolume}", "${supply}", "${purchasePrice}", "${sellPrice}"
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
  console.log('Updated marketplace data for', waypointSymbol);
}

module.exports = {
  updateMarketplaceData,
}
