import assert from "node:assert/strict";
import test from "node:test";
import { renderOAKSAPI, renderOAKSStatic, renderOAKSUpstreams } from "../generate-docker";
import { mongoURI } from "../src/mongo-target";

test("Docker Nginx 逐游戏生成唯一 upstream 和 location", () => {
  const games = [
    { gameId: 32601, slug: "sun_of_egypt", title: "Sun of Egypt" },
    { gameId: 32602, slug: "lucky_penny", title: "Lucky Penny" },
  ];
  const upstream = renderOAKSUpstreams(games);
  const api = renderOAKSAPI(games);
  assert.match(upstream, /upstream oaks_game_19601/);
  assert.match(upstream, /server api-server:19602/);
  assert.match(api, /location \/sun_of_egypt\//);
  assert.match(api, /proxy_pass http:\/\/oaks_game_19602/);
  assert.match(renderOAKSStatic(), /client\/game\/oaks\/static/);
});

test("测试服 MongoDB 连接串必须由环境显式提供", () => {
  const previous = process.env.OAKS_TEST_MONGO_URI;
  delete process.env.OAKS_TEST_MONGO_URI;
  try { assert.throws(() => mongoURI("test"), /OAKS_TEST_MONGO_URI/); }
  finally {
    if (previous === undefined) delete process.env.OAKS_TEST_MONGO_URI;
    else process.env.OAKS_TEST_MONGO_URI = previous;
  }
});
