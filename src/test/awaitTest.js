const timer = s => new Promise( res => setTimeout(res, s * 1000));

const main = async () => {
  const loopOnePromise = loop('Loop one', 1);
  const loopTwoPromise = loop('Loop two', 10);
  await Promise.all([loopOnePromise, loopTwoPromise]);
}

const loop = async(loopName, seconds) => {
  while (true) {
    console.log(loopName);
    await timer(seconds);
  }
}
main();