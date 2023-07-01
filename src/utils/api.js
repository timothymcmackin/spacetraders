require('dotenv').config();
const axios = require('axios');
const rateLimit = require('axios-rate-limit');

const api = rateLimit(axios.create({
  baseURL: 'https://api.spacetraders.io/v2/',
  timeout: 5000,
  headers: { 'Authorization': `Bearer ${process.env.SPACETRADERS_TOKEN}` },
}),
  // Limit to 1 request per second
  // https://github.com/aishek/axios-rate-limit
  { maxRPS: 1}
);

// Utility functions to get rid of the data:data in every request
const get = (path) => api.get(path)
  .then(async (response) => {
    let { status, data } = response;
    if (status === 429) {
      console.log('Rate limit on GET', path);
      await timer(2 * 60);
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
  post,
}
