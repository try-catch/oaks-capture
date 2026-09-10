import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface ResourceRecord {
  url: string;
  localPath: string;
  status: number;
  size: number;
  sha256: string;
  discoveredFrom: string;
  contentType: string;
  emptyAllowed?: boolean;
}

export interface ResourceFailure {
  url: string;
  status?: number;
  error: string;
  discoveredFrom: string;
}

export interface ResourceGraph {
  files: ResourceRecord[];
  failed: ResourceFailure[];
}

export interface ResourceGraphOptions {
  concurrency: number;
  allowedHosts: Set<string>;
  target: string;
  timeoutMs?: number;
}

const TEXT_EXTENSIONS = new Set([
  ".atlas", ".css", ".fnt", ".html", ".htm", ".js", ".json", ".manifest", ".map", ".mjs", ".svg", ".txt", ".xml",
]);
const RESOURCE_EXTENSION = /\.(?:atlas|avif|bin|css|csv|eot|fnt|gif|html?|ico|jpe?g|js|json|manifest|map|mjs|mp3|mp4|ogg|otf|png|svg|ttf|txt|wav|webm|webp|woff2?|xml)(?:[?#].*)?$/i;

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalUrl(value: string, base: URL): URL | undefined {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "").replace(/\\\//g, "/");
  if (!cleaned || /^(?:data|blob|javascript|mailto):/i.test(cleaned) || cleaned.startsWith("#")) return undefined;
  try {
    const url = new URL(cleaned.startsWith("//") ? `https:${cleaned}` : cleaned, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function isText(url: URL, contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.startsWith("text/") || type.includes("javascript") || type.includes("json") ||
    type.includes("xml") || type.includes("svg") || TEXT_EXTENSIONS.has(path.extname(url.pathname).toLowerCase());
}

function kendooResourceMap(text: string, base: URL): URL[] {
  if (!/\/clients_kendoo\//i.test(base.pathname) || !/resourceMap\.runpack\.json$/i.test(base.pathname)) return [];
  const document = JSON.parse(text) as { resources?: Record<string, unknown> };
  const root = base.href.match(/^(https?:\/\/[^/]+\/gs\/clients_kendoo\/[^/]+\/[^/]+\/)/i)?.[1];
  if (!root) return [];
  const paths = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "path" && typeof child === "string") paths.add(child);
      else walk(child);
    }
  };
  for (const [logicalPath, descriptor] of Object.entries(document.resources ?? {})) {
    if (typeof descriptor === "number") {
      if (/^(?:audio|mechanics|particles|symbolFeeder)\//i.test(logicalPath) || /^(?:filelist|winModes)\.json$/i.test(logicalPath)) {
        paths.add(`json/${logicalPath}`);
      } else if (/^css\//i.test(logicalPath)) {
        paths.add(logicalPath);
      } else {
        paths.add(`resources/${logicalPath}`);
      }
    } else {
      walk(descriptor);
    }
  }
  return [...paths].map((value) => new URL(value, root));
}

function extractReferences(text: string, base: URL): URL[] {
  if (/\/clients_kendoo\//i.test(base.pathname)) {
    if (/resourceMap\.runpack\.json$/i.test(base.pathname)) return kendooResourceMap(text, base);
    if ([".js", ".mjs", ".json"].includes(path.extname(base.pathname).toLowerCase())) return [];
  }
  const candidates = new Set<string>();
  const sourceExtension = path.extname(base.pathname).toLowerCase();
  const patterns = [
    /\b(?:src|href|url|static_path|client_url)\s*[:=]\s*["']([^"']+)["']/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    /@import\s+(?:url\()?\s*["']([^"']+)["']/gi,
    /["']((?:https?:)?\/\/[^"']+)["']/gi,
    /["']((?:\.\.\/|\.\/|\/)?(?:assets|audio|canvas_assets[^/]*|fonts|i18n|images|sounds|textures|video)\/[^"']+\.(?:atlas|avif|bin|css|eot|fnt|gif|html?|ico|jpe?g|js|json|manifest|map|mjs|mp3|mp4|ogg|otf|png|svg|ttf|txt|wav|webm|webp|woff2?|xml)(?:[?#][^"']*)?)["']/gi,
  ];
  if ([".xml", ".svg", ".html", ".htm"].includes(sourceExtension)) {
    patterns.push(/["']([^"']+\.(?:atlas|avif|bin|css|eot|fnt|gif|ico|jpe?g|js|json|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?)(?:[?#][^"']*)?)["']/gi);
  }
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) candidates.add(match[1]);
  }
  if (sourceExtension === ".json" && /-\d+\.json$/i.test(base.pathname)) {
    for (const match of text.matchAll(/["']image["']\s*:\s*["']([^"']+)["']/gi)) {
      const original = match[1];
      const originalExtension = path.extname(original);
      if (!originalExtension) continue;
      candidates.delete(original);
      const packExtension = /_avif\//i.test(base.pathname) ? ".avif" :
        /_webp\//i.test(base.pathname) ? ".webp" : originalExtension;
      candidates.add(`${path.basename(base.pathname, sourceExtension)}${packExtension}`);
    }
  }
  if (sourceExtension === ".atlas" || sourceExtension === ".fnt") {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length - 1; index++) {
      const value = lines[index].trim();
      const next = lines[index + 1].trim().toLowerCase();
      if (RESOURCE_EXTENSION.test(value) && next.startsWith("size:")) candidates.add(value);
    }
  }
  const urls = new Map<string, URL>();
  for (const candidate of candidates) {
    if (/\$\{|[\s{},`]/.test(candidate)) continue;
    if (!RESOURCE_EXTENSION.test(candidate) && !/^https?:\/\//i.test(candidate) && !/^\/\//.test(candidate)) continue;
    const extension = candidate.match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/)?.[1] ?? "";
    if (extension && extension !== extension.toLowerCase()) continue;
    const isBare = !candidate.includes("/") && !candidate.startsWith(".");
    if (isBare && [".js", ".mjs", ".html", ".htm", ".svg"].includes(sourceExtension)) continue;
    let resolutionBase = base;
    let candidateForResolution = candidate;
    if (sourceExtension === ".js" || sourceExtension === ".mjs") {
      if (candidateForResolution.startsWith("../")) continue;
      const runtimeRoot = base.href.match(/^(https?:\/\/[^/]+\/(?:gs\/clients_[^/]+\/[^/]+\/[^/]+|gs\/gamerunner\/[^/]+|3oaks\/gs\/promo-widget\/[^/]+)\/)/i)?.[1];
      if (runtimeRoot) {
        if (/\/gs\/gamerunner\//i.test(runtimeRoot) && /^(?:src\/(?:game|libs)\.js|ui-new\/)/i.test(candidateForResolution)) continue;
        resolutionBase = new URL(runtimeRoot);
        if (candidateForResolution.startsWith("./")) candidateForResolution = candidateForResolution.slice(2);
      }
    }
    const url = canonicalUrl(candidateForResolution, resolutionBase);
    if (url) urls.set(url.href, url);
  }
  return [...urls.values()];
}

function destinationPath(target: string, url: URL): string {
  const root = path.resolve(target);
  const destination = path.resolve(root, url.pathname.replace(/^\/+/, ""));
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`资源本地路径越界: ${url.href}`);
  }
  return destination;
}

async function atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, destination);
}

export async function crawlResourceGraph(
  entryUrls: URL[],
  fetcher: typeof fetch,
  options: ResourceGraphOptions,
): Promise<ResourceGraph> {
  const allowedHosts = new Set([...options.allowedHosts].map((host) => host.toLowerCase()));
  const queue: Array<{ url: URL; discoveredFrom: string }> = [];
  const seen = new Set<string>();
  const files: ResourceRecord[] = [];
  const failed: ResourceFailure[] = [];
  for (const entry of entryUrls) queue.push({ url: new URL(entry.href), discoveredFrom: "entry" });

  const processOne = async ({ url, discoveredFrom }: { url: URL; discoveredFrom: string }): Promise<URL[]> => {
    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      if (discoveredFrom === "entry") {
        failed.push({ url: url.href, error: `资源主机不在允许列表: ${url.hostname}`, discoveredFrom });
      }
      return [];
    }
    const destination = destinationPath(options.target, url);
    try {
      let bytes: Uint8Array;
      let status = 200;
      let contentType = "";
      const existing = await fs.readFile(destination).catch(() => undefined);
      let emptyAllowed = false;
      if (existing?.length) {
        bytes = existing;
        contentType = TEXT_EXTENSIONS.has(path.extname(url.pathname).toLowerCase()) ? "text/plain" : "application/octet-stream";
      } else {
        const response = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 30000) });
        status = response.status;
        contentType = response.headers.get("content-type") ?? "";
        if (!response.ok) throw Object.assign(new Error(`${response.status} ${response.statusText}`), { status: response.status });
        bytes = new Uint8Array(await response.arrayBuffer());
        emptyAllowed = !bytes.length && response.headers.get("content-length") === "0";
        if (!bytes.length && !emptyAllowed) throw new Error("empty response");
        await atomicWrite(destination, bytes);
      }
      files.push({
        url: url.href,
        localPath: destination,
        status,
        size: bytes.length,
        sha256: sha256(bytes),
        discoveredFrom,
        contentType,
        ...(emptyAllowed ? { emptyAllowed: true } : {}),
      });
      if (!isText(url, contentType)) return [];
      return extractReferences(Buffer.from(bytes).toString("utf8"), url);
    } catch (error) {
      const status = Number((error as { status?: unknown }).status);
      failed.push({
        url: url.href,
        ...(Number.isFinite(status) ? { status } : {}),
        error: (error as Error).message,
        discoveredFrom,
      });
      return [];
    }
  };

  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency) || 1));
  while (queue.length) {
    const batch: Array<{ url: URL; discoveredFrom: string }> = [];
    while (queue.length && batch.length < concurrency) {
      const item = queue.shift()!;
      const key = item.url.href;
      if (seen.has(key)) continue;
      seen.add(key);
      batch.push(item);
    }
    if (!batch.length) continue;
    const discovered = await Promise.all(batch.map(processOne));
    discovered.forEach((urls, index) => {
      for (const url of urls) {
        if (!seen.has(url.href)) queue.push({ url, discoveredFrom: batch[index].url.href });
      }
    });
  }
  files.sort((left, right) => left.url.localeCompare(right.url));
  failed.sort((left, right) => left.url.localeCompare(right.url));
  return { files, failed };
}
