import type { Server } from 'node:http';
import type { Express } from 'express';

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Start an Express app on an ephemeral port and talk to it over real HTTP. */
export async function startServer(app: Express): Promise<TestServer> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface JsonResponse {
  status: number;
  // Responses are only ever read in assertions, so an untyped body is fine here.
  body: any;
  headers: Headers;
}

export async function getJson(base: string, path: string): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}
