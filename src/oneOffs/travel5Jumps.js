require('dotenv').config();
const {
  navigate,
  getSystemFromWaypoint,
  getSystemJumpGateWaypointSymbol,
  getRandomElement,
  jump,
} = require('../utils/utils');
const {
  get, post,
} = require('../utils/api');
const {
  endPool,
  singleQuery,
  initDatabase,
} = require('../utils/databaseUtils');
const { flatten } = require('lodash');
const { getPathToSystem } = require('../utils/pathingUtils');

// Travel 5 random jumps to get away from the faction starting system, which is usually crowded
// Take this opprotunity to test inter-jump pathing
// Turns out that you don't need to go to a jump gate to know where it goes
const getnewStartingSystem = async (shipSymbol, numberOfJumps) => {
  const currentTables = flatten(await singleQuery('SHOW TABLES'))
  .map(({Tables_in_spacetraders}) => Tables_in_spacetraders);

  const tempTableName = 'jumpPathsForNewSystem';
  if (currentTables.includes(tempTableName)) {
    await singleQuery('DROP TABLE ' + tempTableName);
  }
  // Where you can go from each jump gate
  await singleQuery(`CREATE TABLE ${tempTableName} (
    id int(11) NOT NULL AUTO_INCREMENT,
    systemA varchar(255),
    systemB varchar(255),
    PRIMARY KEY (id))`);

  const ship = await get('/my/ships/' + shipSymbol);
  const { systemSymbol: startingSystemSymbol } = ship.nav;

  var visitedSystems = [startingSystemSymbol];
  var currentSystemSymbol = startingSystemSymbol;
  for (let i = 0; i < numberOfJumps; i++) {
    const jumpGateWaypointSymbol = await getSystemJumpGateWaypointSymbol(currentSystemSymbol);
    // Get the systems that you can jump to from this gate
    const { connectedSystems } = await get(`/systems/${currentSystemSymbol}/waypoints/${jumpGateWaypointSymbol}/jump-gate`);
    // Filter to the systems that have a jump gate at the other end
    const connectedSystemsWithJumpGates = await connectedSystems.reduce(async (prevPromise, { symbol: connectedSystemSymbol }) => {
      const systemsList = await prevPromise;
      const jgWaypoint = await getSystemJumpGateWaypointSymbol(connectedSystemSymbol);
      if (jgWaypoint) {
        systemsList.push(getSystemFromWaypoint(jgWaypoint));
      }
      return systemsList;
    }, Promise.resolve([]));
    const connectedSystemsWithJumpGatesFiltered = connectedSystemsWithJumpGates
      .filter((sysSymbol) => !visitedSystems.includes(sysSymbol));

    var nextSystemSymbol;
    if (connectedSystemsWithJumpGatesFiltered.length === 1) {
      nextSystemSymbol = connectedSystemsWithJumpGatesFiltered[0];
    } else if (connectedSystemsWithJumpGatesFiltered.length > 1) {
      nextSystemSymbol = getRandomElement(connectedSystemsWithJumpGatesFiltered);
    }

    if (nextSystemSymbol) {
      // Add to database for pathing later
      await singleQuery(`INSERT INTO ${tempTableName} (systemA, systemB)
      VALUES ("${visitedSystems[visitedSystems.length - 1]}", "${nextSystemSymbol}")`);
      visitedSystems.push(nextSystemSymbol);
      currentSystemSymbol = nextSystemSymbol;
    } else {
      // I don't know what to do here
      // Found a dead end; maybe back up one?
      console.log('oops');
    }
  }

  var path = await getPathToSystem(startingSystemSymbol, visitedSystems[visitedSystems.length - 1], tempTableName);
  console.log(path);
  const finalSystemSymbol = path[path.length - 1];
  await jump(ship, finalSystemSymbol, tempTableName);
  console.log(finalSystemSymbol);
}

getnewStartingSystem(process.env.ACTIVE_SHIP, 5)
  .catch(console.error)
  .finally(endPool);
