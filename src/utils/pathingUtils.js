const { find_path } = require('dijkstrajs');
const { flatten } = require('lodash');
const { singleQuery, getPool } = require('./databaseUtils');

const pathingTest = () => {
  // A B C
  // D E F
  // G H I
  const graph = {
  a: {b: 1, d: 1},
  b: {a: 1, c: 1, e: 1},
  c: {b: 1, f: 1},
  d: {a: 1, e: 1, g: 1},
  e: {b: 1, d: 1, f: 1, h: 1},
  f: {c: 1, e: 1, i: 1},
  g: {d: 1, h: 1},
  h: {e: 1, g: 1, i: 1},
  i: {f: 1, h: 1}
  };
  const path = find_path(graph, 'a', 'i');
  console.log(path);

  // Simulate getting system data from the jumpPaths table
  const jumpPathsSimulated = [
    {
      a: "A",
      b: "B",
    },
    {
      a: "A",
      b: "D",
    },
    {
      a: "B",
      b: "C",
    },
    {
      a: "B",
      b: "E",
    },
    {
      a: "C",
      b: "F",
    },
    {
      a: "D",
      b: "E",
    },
    {
      a: "D",
      b: "G",
    },
    {
      a: "E",
      b: "B",
    },
    {
      a: "E",
      b: "D",
    },
    {
      a: "E",
      b: "F",
    },
    {
      a: "E",
      b: "H",
    },
    {
      a: "F",
      b: "I",
    },
    {
      a: "G",
      b: "H",
    },
    {
      a: "H",
      b: "I",
    },
  ];

  const myPathGraph = jumpPathsSimulated.reduce((graphInProgress, { a, b }) => {
    if (!graphInProgress[a]) {
      graphInProgress[a] = {};
    }
    if (!graphInProgress[b]) {
      graphInProgress[b] = {};
    }
    graphInProgress[a][b] = 1;
    graphInProgress[b][a] = 1;
    return graphInProgress;
  }, {});

  console.log(find_path(myPathGraph, "A", "I"));
}

// Returns ['a', 'b', 'c', 'd']
const getPathToSystem = async (sourceSystem, destinationSystem, tableName = 'jumpPaths') => {
  let pool = getPool();
  // [{ systemA, systemB }]
  const jumpPathsData = await singleQuery(`select systemA, systemB from ${tableName}`, pool);
  pool.end();
  // Get every endpoint
  const allEndpoints = jumpPathsData.reduce((endpoints, { systemA, systemB }) => {
    if (!endpoints.includes(systemA)) {
      endpoints.push(systemA);
    }
    if (!endpoints.includes(systemB)) {
      endpoints.push(systemB);
    }
    return endpoints;
  }, []);

  // Get where we can go from each endpoint
  // dijkstrajs takes this format:
  // {
  //   a: {b: 10, d: 1},
  //   b: {a: 1, c: 1, e: 1},
  //   ...
  // }
  // Could probably add distance here but for now just make all jumps the same
  const graph = allEndpoints.reduce((graphInProgress, endpoint) => {
    const thisEndpointIsSystemA = jumpPathsData
      .filter(({ systemA }) => systemA === endpoint)
      .map(({ systemB }) => systemB);

    const thisEndpointIsSystemB = jumpPathsData
      .filter(({ systemB }) => systemB === endpoint)
      .map(({ systemA }) => systemA);

    const allTargetEndpoints = thisEndpointIsSystemA.reduce((runningList, potentialEndpoint) => {
      if (!runningList.includes(potentialEndpoint)) {
        runningList.push(potentialEndpoint);
      }
      return runningList;
    }, [...thisEndpointIsSystemB]);

    graphInProgress[endpoint] = allTargetEndpoints.reduce((list, endpoint) => {
      list[endpoint] = 1;
      return list;
    }, {});

    return graphInProgress;

  }, {});

  return find_path(graph, sourceSystem, destinationSystem);
}

const testPathingFromDatabase = async () => {
  // Add test data to database
  const testTableName = 'jumpPathsTest';
  let db;
  try {
    db = await fetchConnectionFromPool();
    const currentTables = flatten(await db.query('SHOW TABLES'))
      .map(({Tables_in_spacetraders}) => Tables_in_spacetraders);

    if (currentTables.includes(testTableName)) {
      await db.query('DROP TABLE ' + testTableName);
    }
    // Where you can go from each jump gate
    await db.query(`CREATE TABLE ${testTableName} (
      id int(11) NOT NULL AUTO_INCREMENT,
      systemA varchar(255),
      systemB varchar(255),
      PRIMARY KEY (id))`);

    // Just a straight path for now
    const testData = [
      ['A', 'B'],
      ['C', 'B'],
      ['C', 'D'],
      ['D', 'E'],
      ['E', 'F'],
      ['F', 'G'],
    ];
    await db.beginTransaction();
    await testData.reduce(async (prevPromise, currentArray) => {
      await prevPromise;
      const queryString = `INSERT INTO ${testTableName} (systemA, systemB) VALUES ("${currentArray[0]}", "${currentArray[1]}")`
      await db.query(queryString);
    }, Promise.resolve());
    await db.commit();
  } catch (error) {
    console.log(error);
  } finally {
    db.end();
  }

  // Make sure that the pathing function returns the right path
  const pathResult = await getPathToSystem('A', 'G', testTableName);
  const expectedPathResult = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  if (pathResult.length === expectedPathResult.length && pathResult.every(function(value, index) { return value === expectedPathResult[index]})) {
    console.log('Test passed');
  } else {
    console.log('Test failed.');
  }
}
// testPathingFromDatabase()
//   .catch(console.error)
//   .finally(endPool);

// getPathToSystem('X1-XR4', 'X1-NQ65')
//   .then(console.log)


module.exports = {
  getPathToSystem,
};
