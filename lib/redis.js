const { Redis } = require("@upstash/redis");

function getRedisConfig() {
  var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return {
    url: String(url || "").trim(),
    token: String(token || "").trim(),
  };
}

function createRedis() {
  var cfg = getRedisConfig();
  if (!cfg.url || !cfg.token) {
    var err = new Error(
      "Redis 环境变量缺失：需要 KV_REST_API_URL + KV_REST_API_TOKEN（或 UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN）"
    );
    err.code = "REDIS_ENV_MISSING";
    throw err;
  }
  return new Redis({
    url: cfg.url,
    token: cfg.token,
  });
}

function createMissingEnvClient(err) {
  return {
    __redisError: err,
    ping: function () { return Promise.reject(err); },
    get: function () { return Promise.reject(err); },
    set: function () { return Promise.reject(err); },
    hgetall: function () { return Promise.reject(err); },
    hset: function () { return Promise.reject(err); },
    hget: function () { return Promise.reject(err); },
    incr: function () { return Promise.reject(err); },
    sadd: function () { return Promise.reject(err); },
    scard: function () { return Promise.reject(err); },
    sscan: function () { return Promise.reject(err); },
    pipeline: function () {
      return {
        get: function () { return this; },
        exec: function () { return Promise.reject(err); },
      };
    },
  };
}

var client;
try {
  client = createRedis();
} catch (e) {
  client = createMissingEnvClient(e);
}

client.getRedisConfig = getRedisConfig;
client.createRedis = createRedis;

module.exports = client;
