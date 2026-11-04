import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
};
let db: { close(): void } | undefined;
beforeEach(async () => {
  vi.resetModules();
  values.clear();
  storage.setItem('pi.company', 'co_1');
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { assign: vi.fn() } }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  await Dexie.delete('profitindex-outbox');
});
afterEach(() => { db?.close(); db = undefined; vi.unstubAllGlobals(); });

const scan = { sessionId: 1, code: 'box', itemId: 7, qty: 1, serial: null, unknownName: null, photo: null, source: 'BARCODE' as const };

test('review #1: an old company form refuses to submit after another tab switches', async () => {
  const { post } = await import('../src/lib/api');
  storage.setItem('pi.company', 'co_2');
  await expect(post('/bills/1/post', { itemId: 7 })).rejects.toThrow(/company/i);
  expect(fetch).not.toHaveBeenCalled();
});

test('review #1: requests explicitly carry the tab company, including main', async () => {
  storage.removeItem('pi.company');
  const { post } = await import('../src/lib/api');
  await post('/bills/1/post');
  expect(fetch).toHaveBeenCalledWith('/api/bills/1/post', expect.objectContaining({ headers: expect.objectContaining({ 'x-company': 'main' }) }));
});

test('review #2: matching session IDs never display, delete, or send another company scans', async () => {
  const queue = await import('../src/features/receive/outbox');
  db = queue.outbox;
  const mine = await queue.enqueue(scan);
  await queue.outbox.events.put({ ...mine, clientId: 'other', companyId: 'co_2' } as typeof mine);
  expect(await queue.eventsFor(1)).toEqual([expect.objectContaining({ companyId: 'co_1', clientId: mine.clientId })]);
  await queue.flush(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [, request] = vi.mocked(fetch).mock.calls[0]!;
  expect(request?.headers).toMatchObject({ 'x-company': 'co_1' });
  expect(JSON.parse(request!.body as string).events).toHaveLength(1);
  await queue.forget(1);
  expect(await queue.outbox.events.toArray()).toEqual([expect.objectContaining({ clientId: 'other', sent: 0 })]);
});

test('review #2: queued A scans stay queued when shared storage switches to B during a flush', async () => {
  const queue = await import('../src/features/receive/outbox');
  db = queue.outbox;
  await queue.enqueue(scan);
  storage.setItem('pi.company', 'co_2');
  expect(await queue.flush(1)).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});

test('review #2: upgrading v1 tags both pending and sent scans with the current company', async () => {
  const legacy = new Dexie('profitindex-outbox');
  legacy.version(1).stores({ events: 'clientId, sessionId, sent' });
  await legacy.table('events').bulkPut([
    { ...scan, clientId: 'pending', sent: 0 }, { ...scan, clientId: 'sent', sent: 1 },
  ]);
  legacy.close();
  const queue = await import('../src/features/receive/outbox');
  db = queue.outbox;
  expect(await queue.eventsFor(1)).toEqual([
    expect.objectContaining({ companyId: 'co_1', clientId: 'pending' }),
    expect.objectContaining({ companyId: 'co_1', clientId: 'sent' }),
  ]);
});

test('review #2: resume pointers require company identity; legacy and foreign pointers are ignored', async () => {
  const queue = await import('../src/features/receive/outbox');
  db = queue.outbox;
  storage.setItem('pi.receive', JSON.stringify({ sessionId: 1, step: 2 }));
  expect(queue.recalled()).toBeNull();
  storage.setItem('pi.receive', JSON.stringify({ companyId: 'co_2', sessionId: 1, step: 2 }));
  expect(queue.recalled()).toBeNull();
  queue.remember({ sessionId: 1, step: 2 });
  expect(JSON.parse(storage.getItem('pi.receive')!)).toEqual({ companyId: 'co_1', sessionId: 1, step: 2 });
  expect(queue.recalled()).toMatchObject({ sessionId: 1, step: 2 });
});

test('review #1: switching while a request is in flight discards its response', async () => {
  const { post } = await import('../src/lib/api');
  let reply!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
  const request = post('/bills/1/post');
  storage.setItem('pi.company', 'co_2');
  reply(new Response('{"id":1}'));
  await expect(request).rejects.toThrow(/company/i);
  expect(vi.mocked(fetch).mock.calls[0]![1]?.headers).toMatchObject({ 'x-company': 'co_1' });
});

test('review #2: a switch between batches cannot redirect the remaining scans', async () => {
  const queue = await import('../src/features/receive/outbox');
  db = queue.outbox;
  for (let i = 0; i < 101; i++) await queue.enqueue(scan);
  let reply!: (response: Response) => void;
  let started!: () => void;
  const firstRequest = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(fetch).mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => { reply = resolve; });
  });
  const flushing = queue.flush(1);
  await firstRequest;
  storage.setItem('pi.company', 'co_2');
  reply(new Response('[]'));
  expect(await flushing).toBe(101);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]![1]?.headers).toMatchObject({ 'x-company': 'co_1' });
});

test('review #2: simultaneous sessions flush independently', async () => {
  const queue = await import('../src/features/receive/outbox');
  db = queue.outbox;
  await queue.enqueue(scan);
  await queue.enqueue({ ...scan, sessionId: 2 });
  expect(await Promise.all([queue.flush(1), queue.flush(2)])).toEqual([0, 0]);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url).sort()).toEqual(['/api/scan-sessions/1/events', '/api/scan-sessions/2/events']);
});
