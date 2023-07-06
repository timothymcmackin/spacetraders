require('dotenv').config();
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const axiosRetry = require('axios-retry');

const client = axios.create({
  baseURL: 'https://api.spacetraders.io/v2/',
  timeout: 50000,
  headers: { 'Authorization': `Bearer ${process.env.SPACETRADERS_TOKEN}` },
});
axiosRetry(client, { retries: 3 });

const api = rateLimit(client,
  // Limit to 1 request per second
  // https://github.com/aishek/axios-rate-limit
  { maxRPS: 1}
);

// Utility functions to get rid of the data:data in every request
const get = async (path) => {
  var keepGoing = false;
  const { data: firstResult, status } = await api.get(path);
  if (status === 429) {
    console.log('Rate limit on GET', path);
    await timer(2 * 60);
  } else if (!status.toString().startsWith('2')){
    console.log("ErrorCode:", data?.error?.code);
    console.log(JSON.stringify(result.error, null, 2))
  }
  if (firstResult.meta && firstResult.meta.limit < firstResult.meta.total) {
    keepGoing = true;
  } else {
    // No paging needed
    return firstResult.data;
  }

  // Paging
  var returnData = firstResult.data;
  var currentPage = 1;
  const { total, limit } = firstResult.meta;
  var remainingRecords = total - limit;
  while (keepGoing) {
    // If there are fewer than or equal to `limit` records left, get only those
    // and that's the last page
    var numberOfRecordsToGet;
    if (remainingRecords <= limit) {
      // This is the last request needed
      keepGoing = false;
      numberOfRecordsToGet = remainingRecords;
      remainingRecords -= numberOfRecordsToGet;
    } else {
      numberOfRecordsToGet = limit;
    }

    currentPage++;
    const nextResult = await api.get(`${path}?page=${currentPage}`);
    returnData = returnData.concat(...nextResult.data.data);
  }

  return returnData;
}

const post = (path, body = {}) => api.post(path, body)
  .then(async (response) => {
    let { status, data } = response;
    if (status === 429) {
      console.log('Rate limit on POST', path);
      await timer(2 * 60);
    } else if (status === 409 && response?.data?.error?.code === 4000) {
      // Too soon for cooldown
      const remainingCooldown = response.data.error.data.cooldown.remainingSeconds;
      await timer(remainingCooldown);
      const newResponse = await api.post(path, body);
      data = newResponse.data;
    } else if (!status.toString().startsWith('2')){
      console.log("ErrorCode:", response?.data?.error?.code);
      console.log(JSON.stringify(result.error, null, 2))
    }
    const { data: result } = data;
    return result;
  })
  .catch((error) => {
    console.log(JSON.stringify(error.response?.data ? error.response.data : error, null, 2));
  });

module.exports = {
  get,
  post
}
