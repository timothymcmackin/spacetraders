var factory = function(){
  var time = 0, count = 0, difference = 0, queue = [];
  return function limit(prom){
      if(prom) queue.push(prom);
      difference = 1000 - (new Date() - time);
      if(difference <= 0) {
          time = new Date();
          count = 0;
      }
      if(++count <= 1) (queue.shift())();
      else setTimeout(limit, difference);
  };
};

var limited = factory();
var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// This is to show a separator when waiting.
// var prevDate = new Date(), difference;

// This ends up as 2600 function calls,
// all executed in the order in which they were queued.
// for(var i = 0; i < 1; ++i) {
//   alphabet.forEach(function(letter) {
//       limited(function(){
//           /** This is to show a separator when waiting. **/
//           // difference = new Date() - prevDate;
//           // prevDate   = new Date();
//           // if(difference > 100) console.log('wait');
//           /***********************************************/
//           console.log(letter);
//       });
//   });
// }

async function tryWithPromises() {
  for(var i = 0; i < 1; ++i) {
    alphabet.forEach(function(letter) {
        limited(new Promise((resolve) => {
          console.log(letter);
          resolve();
        }));
    });
  }
}

tryWithPromises();