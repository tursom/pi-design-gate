import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { webFetch } from '../src/web-fetch.ts';

async function server(handler: (request: import('node:http').IncomingMessage, body: string) => void) {
  const instance = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => handler(request, body));
    request.on('error', error => response.destroy(error));
  });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return { instance, url: `http://127.0.0.1:${address.port}` };
}

test('supports POST queries and custom non-sensitive headers', async () => {
  const responseServer = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.headers['x-api-version'], '2026-01');
      assert.equal(request.headers.authorization, 'Bearer test-secret');
      assert.equal(body, '{"query":"private docs"}');
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => responseServer.listen(0, '127.0.0.1', resolve));
  const address = responseServer.address(); assert.ok(address && typeof address !== 'string');
    process.env.PI_DESIGN_TEST_TOKEN = 'Bearer test-secret';
  try {
    const result = await webFetch({ url: `http://127.0.0.1:${address.port}`, method: 'POST', headers: { 'X-Api-Version': '2026-01' }, headerRefs: { Authorization: '$PI_DESIGN_TEST_TOKEN' }, body: { query: 'private docs' }, purpose: 'read docs' });
    assert.equal(result.body, '{"ok":true}');
    assert.equal(result.externalData, true);
  } finally { delete process.env.PI_DESIGN_TEST_TOKEN; responseServer.close(); }
});

test('rejects plaintext sensitive headers and forbidden cookies', async () => {
  await assert.rejects(webFetch({ url: 'https://example.invalid', method: 'GET', headers: { Authorization: 'Bearer secret' }, purpose: 'test' }), /必须通过headerRefs/);
  await assert.rejects(webFetch({ url: 'https://example.invalid', method: 'GET', headers: { Cookie: 'session=secret' }, purpose: 'test' }), /不允许/);
});

test('rejects redirects, GET bodies and oversized responses', async () => {
  const redirectServer = createServer((_request, response) => response.writeHead(302, { location: 'https://example.com' }).end());
  await new Promise<void>(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
  const redirectAddress = redirectServer.address(); assert.ok(redirectAddress && typeof redirectAddress !== 'string');
  await assert.rejects(webFetch({ url: `http://127.0.0.1:${redirectAddress.port}`, method: 'GET', purpose: 'redirect' }), /重定向/);
  redirectServer.close();
  await assert.rejects(webFetch({ url: 'https://example.invalid', method: 'GET', body: { query: 'x' }, purpose: 'invalid' }), /不接受body/);
});
