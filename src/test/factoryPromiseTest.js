const apiFactory = function() {
  var time = 0, count = 0, difference = 0, queue = [];
  return async function limit({method, path, body = {}}){
      if (method && path) queue.push(({method, path, body}));
      // difference = 1000 - (new Date() - time);
      // if(difference <= 0) {
      //     time = new Date();
      //     count = 0;
      // }
      // if(++count <= 1) {
      //   const {
      //     method: methodToRun,
      //     path: pathToRun,
      //     body: bodyToRun,
      //   } = queue.shift();
      //   console.log('Running ', methodToRun, '', pathToRun);
      // } else setTimeout(limit, difference);
  };
};

const apiRunner = apiFactory();
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
for(var i = 0; i < 1; ++i) {
  alphabet.forEach(function(letter) {
    apiRunner({method: 'GET', path: letter});
  });
}