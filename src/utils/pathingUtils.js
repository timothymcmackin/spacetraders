const { find_path } = require('dijkstrajs');
const { singleQuery, endPool } = require('./databaseUtils');

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

const getPathToSystem = async (sourceSystem, destinationSystem) => {
  // [{ systemA, systemB }]
  const jumpPathsData = await singleQuery(`select systemA, systemB from jumpPaths`);
  const graph = jumpPathsData.reduce((graphInProgress, { a, b }) => {
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
  return find_path(graph, sourceSystem, destinationSystem);
}

module.exports = {
  getPathToSystem,
};
