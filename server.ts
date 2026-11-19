import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import type {Request, Response} from 'express';

type AdNetwork = 'adsterra' | 'monetag';
type TimerDuration = 30 | 60 | 120;

interface StoredLinkRecord {
  id: string;
  network: AdNetwork;
  smartLink: string;
  timerSeconds: TimerDuration;
  destinationUrl: string;
  imageDataUrl: string;
  mimeType: string;
  width?: number;
  height?: number;
  createdAt: number;
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.resolve(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');
const SHORT_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SHORT_ID_LENGTH = 7;
const MAX_STORED_LINKS = 5000;
const MAX_IMAGE_DATA_URL_LENGTH = 1_200_000;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const linksStore = new Map<string, StoredLinkRecord>();
let writeChain: Promise<void> = Promise.resolve();

function isValidHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return Boolean(
      parsed.hostname && (parsed.hostname.includes('.') || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateShortId(): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const bytes = crypto.randomBytes(SHORT_ID_LENGTH);
    let id = '';
    for (let i = 0; i < SHORT_ID_LENGTH; i++) {
      id += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
    }
    if (!linksStore.has(id)) {
      return id;
    }
  }
  return crypto
    .randomBytes(6)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'A')
    .slice(0, 8);
}

async function loadLinksFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as StoredLinkRecord).id === 'string' &&
          typeof (item as StoredLinkRecord).smartLink === 'string' &&
          typeof (item as StoredLinkRecord).destinationUrl === 'string' &&
          typeof (item as StoredLinkRecord).imageDataUrl === 'string'
        ) {
          const record = item as StoredLinkRecord;
          linksStore.set(record.id, record);
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error('Failed to load stored short links:', err);
    }
  }
}

function persistLinksToDisk(): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(DATA_DIR, {recursive: true});
      const records = Array.from(linksStore.values());
      const tempFile = `${DATA_FILE}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify(records), 'utf8');
      await fs.rename(tempFile, DATA_FILE);
    })
    .catch((err) => {
      console.error('Failed to persist short links:', err);
    });
  return writeChain;
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function getImageExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}


function injectShareMetaTags(html: string, record: StoredLinkRecord, origin: string): string {
  const pageUrl = `${origin}/s/${record.id}`;
  const ext = getImageExtension(record.mimeType);
  const imageUrl = `${origin}/s/${record.id}/image.${ext}`;
  const title = 'Shared Image';
  const description = 'Click the image to view and continue.';

  const dimensionTags =
    typeof record.width === 'number' &&
    typeof record.height === 'number' &&
    record.width > 0 &&
    record.height > 0
      ? `\n    <meta property="og:image:width" content="${record.width}" />\n    <meta property="og:image:height" content="${record.height}" />`
      : '';

  const metaBlock = `    <title>${title}</title>
    <link rel="canonical" href="${escapeHtmlAttr(pageUrl)}" />
    <meta name="description" content="${escapeHtmlAttr(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtmlAttr(pageUrl)}" />
    <meta property="og:title" content="${escapeHtmlAttr(title)}" />
    <meta property="og:description" content="${escapeHtmlAttr(description)}" />
    <meta property="og:image" content="${escapeHtmlAttr(imageUrl)}" />
    <meta property="og:image:url" content="${escapeHtmlAttr(imageUrl)}" />
    <meta property="og:image:secure_url" content="${escapeHtmlAttr(imageUrl)}" />
    <meta property="og:image:type" content="${escapeHtmlAttr(record.mimeType)}" />
    <meta property="og:image:alt" content="${escapeHtmlAttr(title)}" />${dimensionTags}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtmlAttr(title)}" />
    <meta name="twitter:description" content="${escapeHtmlAttr(description)}" />
    <meta name="twitter:image" content="${escapeHtmlAttr(imageUrl)}" />
    <meta name="twitter:image:alt" content="${escapeHtmlAttr(title)}" />`;

  return html.replace(/<!--\s*META_START\s*-->[\s\S]*?<!--\s*META_END\s*-->/, metaBlock);
}

async function startServer(): Promise<void> {
  await loadLinksFromDisk();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({limit: '2mb'}));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ok: true});
  });

  app.post('/api/links', async (req: Request, res: Response) => {
    const body = req.body as Partial<StoredLinkRecord> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({error: 'Invalid request payload.'});
      return;
    }

    const {network, smartLink, timerSeconds, destinationUrl, imageDataUrl, mimeType, width, height} =
      body;

    if (network !== 'adsterra' && network !== 'monetag') {
      res.status(400).json({error: 'Select either Adsterra or Monetag Smart Link.'});
      return;
    }

    if (timerSeconds !== 30 && timerSeconds !== 60 && timerSeconds !== 120) {
      res.status(400).json({error: 'Timer must be 30 Seconds, 1 Minute, or 2 Minutes.'});
      return;
    }

    if (!isValidHttpUrl(smartLink)) {
      res.status(400).json({error: 'Smart Link must be a valid http:// or https:// URL.'});
      return;
    }

    if (!isValidHttpUrl(destinationUrl)) {
      res.status(400).json({error: 'Final Redirect Link must be a valid http:// or https:// URL.'});
      return;
    }

    if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType)) {
      res.status(400).json({error: 'Unsupported image MIME type.'});
      return;
    }

    if (
      typeof imageDataUrl !== 'string' ||
      !imageDataUrl.startsWith(`data:${mimeType};base64,`) ||
      imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH
    ) {
      res.status(400).json({error: 'Uploaded image data is invalid or exceeds size limit.'});
      return;
    }

    if (linksStore.size >= MAX_STORED_LINKS) {
      const oldestKey = linksStore.keys().next().value;
      if (oldestKey) {
        linksStore.delete(oldestKey);
      }
    }

    const id = generateShortId();
    const record: StoredLinkRecord = {
      id,
      network,
      smartLink: new URL(smartLink.trim()).toString(),
      timerSeconds,
      destinationUrl: new URL(destinationUrl.trim()).toString(),
      imageDataUrl,
      mimeType,
      width: typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : undefined,
      height: typeof height === 'number' && Number.isFinite(height) ? Math.round(height) : undefined,
      createdAt: Date.now(),
    };

    linksStore.set(id, record);
    await persistLinksToDisk();

    res.status(201).json({
      id,
      shortPath: `/s/${id}`,
    });
  });

  app.get('/api/links/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id || !/^[A-Za-z0-9]{4,16}$/.test(id)) {
      res.status(400).json({error: 'Invalid short link identifier.'});
      return;
    }

    const record = linksStore.get(id);
    if (!record) {
      res.status(404).json({error: 'This short redirect link was not found.'});
      return;
    }

    res.json({
      id: record.id,
      network: record.network,
      smartLink: record.smartLink,
      timerSeconds: record.timerSeconds,
      destinationUrl: record.destinationUrl,
      imageDataUrl: record.imageDataUrl,
      mimeType: record.mimeType,
    });
  });

  // Binary image endpoint for Facebook & X/Twitter OpenGraph crawlers
  const serveShareImage = (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id || !/^[A-Za-z0-9]{4,16}$/.test(id)) {
      res.status(400).send('Invalid image identifier.');
      return;
    }

    const record = linksStore.get(id);
    if (!record) {
      res.status(404).send('Image not found.');
      return;
    }

    const commaIndex = record.imageDataUrl.indexOf(',');
    if (commaIndex === -1) {
      res.status(500).send('Invalid image payload.');
      return;
    }

    const base64Data = record.imageDataUrl.slice(commaIndex + 1);
    const buffer = Buffer.from(base64Data, 'base64');

    res.setHeader('Content-Type', record.mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buffer);
  };

  app.get('/s/:id/image', serveShareImage);
  app.get('/s/:id/image.:ext', serveShareImage);

  const distDir = path.resolve(process.cwd(), 'dist');
  const hasDist = fsSync.existsSync(path.join(distDir, 'index.html'));
  const isDevLifecycle = process.env.npm_lifecycle_event === 'dev';
  const isProd =
    process.env.NODE_ENV === 'production' ||
    (process.env.NODE_ENV !== 'development' && !isDevLifecycle && hasDist);

  if (!isProd) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });

    app.get('/s/:id', async (req: Request, res: Response, next) => {
      try {
        const id = req.params.id;
        const record = id ? linksStore.get(id) : undefined;
        const rawHtml = await fs.readFile(path.resolve(process.cwd(), 'index.html'), 'utf8');
        let html = await vite.transformIndexHtml(req.originalUrl, rawHtml);
        if (record) {
          html = injectShareMetaTags(html, record, getRequestOrigin(req));
        }
        res.status(200).set({'Content-Type': 'text/html', 'Cache-Control': 'no-store'}).end(html);
      } catch (err) {
        next(err);
      }
    });

    app.use(vite.middlewares);
  } else {
    app.get('/s/:id', async (req: Request, res: Response, next) => {
      try {
        const id = req.params.id;
        const record = id ? linksStore.get(id) : undefined;
        let html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
        if (record) {
          html = injectShareMetaTags(html, record, getRequestOrigin(req));
        }
        res.status(200).set({'Content-Type': 'text/html', 'Cache-Control': 'no-store'}).end(html);
      } catch (err) {
        next(err);
      }
    });

    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`SnapRedirect server listening on http://${HOST}:${PORT}`);
  });
}

void startServer();
