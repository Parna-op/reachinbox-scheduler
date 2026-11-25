import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Express } from 'express';

export interface InProcessResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  rawBody: string;
}

/**
 * Invokes an Express application completely in-process without binding TCP ports.
 */
export async function invokeApp(
  app: Express,
  options: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<InProcessResponse> {
  const payload = options.body !== undefined ? JSON.stringify(options.body) : '';
  const reqSocket = new Duplex({
    read() {},
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  (reqSocket as any).remoteAddress = '127.0.0.1';

  const req = new IncomingMessage(reqSocket as any);
  req.method = options.method;
  req.url = options.url;
  req.headers = {
    host: 'localhost',
    ...(options.body !== undefined
      ? {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload, 'utf8')),
        }
      : {}),
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  if (options.body !== undefined) {
    req.push(Buffer.from(payload, 'utf8'));
    req.push(null);
  }

  const chunks: Buffer[] = [];
  const resSocket = new Duplex({
    read() {},
    write(chunk, encoding, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      cb();
    },
  });

  const res = new ServerResponse(req);
  res.assignSocket(resSocket as any);

  return new Promise<InProcessResponse>((resolve, reject) => {
    res.on('finish', () => {
      const rawHttp = Buffer.concat(chunks).toString('utf8');
      const headerEndIdx = rawHttp.indexOf('\r\n\r\n');
      const rawBody = headerEndIdx >= 0 ? rawHttp.slice(headerEndIdx + 4) : '';
      let parsedBody: any = rawBody;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        parsedBody = rawBody;
      }

      resolve({
        status: res.statusCode,
        headers: res.getHeaders() as Record<string, string | string[] | undefined>,
        body: parsedBody,
        rawBody,
      });
    });

    res.on('error', reject);
    app(req as any, res as any);
  });
}
