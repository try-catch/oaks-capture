import fs from "node:fs/promises";
import path from "node:path";
import { readRegistry } from "./catalog-sync";

const DOCKER_ROOT = process.env.OAKS_DOCKER_ROOT ?? path.resolve(__dirname, "../../../../api_new_docker");
const NGINX_ROOT = path.join(DOCKER_ROOT, "configs/nginx");

export function renderOAKSUpstreams(games: Array<{ gameId: number; slug: string; title: string }>): string {
  return `${games.map((game) => `# ${game.gameId} ${game.title}\nupstream oaks_game_${19601 + game.gameId - 32601} {\n    server api-server:${19601 + game.gameId - 32601} weight=1 max_fails=2 fail_timeout=30s;\n    keepalive 32;\n}`).join("\n\n")}\n`;
}

export function renderOAKSAPI(games: Array<{ gameId: number; slug: string; title: string }>): string {
  const locations = games.map((game) => `    # ${game.gameId} ${game.title}\n    location /${game.slug}/ {\n        proxy_http_version 1.1;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header Host $host:$server_port;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_pass http://oaks_game_${19601 + game.gameId - 32601};\n    }`).join("\n\n");
  return `server {\n    listen 443 ssl;\n    server_name api.oaks-test.com;\n\n    ssl_certificate /home/ca/self-sign.cer;\n    ssl_certificate_key /home/ca/private.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers HIGH:!aNULL:!MD5;\n\n    add_header 'Access-Control-Allow-Origin' '*' always;\n    add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;\n    add_header 'Access-Control-Allow-Headers' 'User-Agent,Keep-Alive,Content-Type' always;\n\n    if ($request_method = 'OPTIONS') {\n        return 204;\n    }\n\n${locations}\n}\n`;
}

export function renderOAKSStatic(): string {
  return `server {\n    listen 443 ssl;\n    server_name static.oaks-test.com;\n\n    ssl_certificate /home/ca/self-sign.cer;\n    ssl_certificate_key /home/ca/private.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_ciphers HIGH:!aNULL:!MD5;\n\n    root /home/ubuntu/api_new/client/game/oaks/static;\n    default_type application/octet-stream;\n\n    location ~* \\.(?:js|css|jpg|jpeg|png|gif|svg|webp|ico|woff2?|ttf|eot|mp3|m4a|wav|ogg|aac|mp4|webm|bin|json|wasm)$ {\n        add_header Cache-Control "public, max-age=2592000";\n        add_header 'Access-Control-Allow-Origin' '*' always;\n        try_files $uri =404;\n    }\n\n    location ~* \\.html$ {\n        add_header Cache-Control "no-cache, must-revalidate";\n        add_header 'Access-Control-Allow-Origin' '*' always;\n        try_files $uri =404;\n    }\n\n    location / {\n        add_header 'Access-Control-Allow-Origin' '*' always;\n        index index.html;\n        try_files $uri $uri/ =404;\n    }\n}\n`;
}

async function main(): Promise<void> {
  const games = (await readRegistry()).games.filter((game) => game.active).sort((left, right) => left.gameId - right.gameId);
  if (games.length !== 107) throw new Error(`Nginx 生成要求 107 款，实际 ${games.length}`);
  await fs.mkdir(NGINX_ROOT, { recursive: true });
  await fs.writeFile(path.join(NGINX_ROOT, "nx_oaks_api_upstream.conf"), renderOAKSUpstreams(games));
  await fs.writeFile(path.join(NGINX_ROOT, "nx_oaks_api.conf"), renderOAKSAPI(games));
  await fs.writeFile(path.join(NGINX_ROOT, "nx_oaks_static.conf"), renderOAKSStatic());
  console.log(`3 OAKS Nginx 配置已生成：${games.length} 个 upstream/location`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
