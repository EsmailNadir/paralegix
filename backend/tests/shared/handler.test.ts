import express from 'express';
import request from 'supertest';

import { handler } from '../../src/shared/http/handler';

/**
 * The wrapper 437 route handlers now go through, so its contract is worth pinning
 * precisely. The cases below are the four behaviours those handlers depended on
 * when they were written out by hand.
 */
describe('handler', () => {
  function appWith(...mount: ((app: express.Express) => void)[]) {
    const app = express();
    app.use(express.json());
    mount.forEach((m) => m(app));
    // The real app's error middleware, reduced to what these cases observe.
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    return app;
  }

  it('sends the returned value as JSON with a 200 by default', async () => {
    const app = appWith((a) => a.get('/thing', handler(async () => ({ ok: true, items: [1, 2] }))));
    const res = await request(app).get('/thing');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, items: [1, 2] });
  });

  it('sends the status it is given, which is how POST routes answer 201', async () => {
    const app = appWith((a) => a.post('/thing', handler(async () => ({ id: 'x' }), 201)));
    const res = await request(app).post('/thing').send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'x' });
  });

  it('forwards a thrown error to the error middleware instead of swallowing it', async () => {
    // The reason no handler needs a try/catch. If this regressed, every service
    // error would surface as a 500 with a generic body instead of its own status.
    const app = appWith((a) => a.get('/thing', handler(async () => {
      const err: any = new Error('Court not found');
      err.status = 404;
      throw err;
    })));
    const res = await request(app).get('/thing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Court not found' });
  });

  it('does not send a second response when the handler already wrote one', async () => {
    // Download and redirect routes write to `res` themselves and return nothing.
    // Sending `undefined` as JSON afterwards would throw ERR_HTTP_HEADERS_SENT.
    const app = appWith((a) => a.get('/file', handler(async (_req, res) => {
      res.status(204).end();
    })));
    const res = await request(app).get('/file');
    expect(res.status).toBe(204);
  });

  it('passes the request through, so params, body and user reach the handler', async () => {
    const app = appWith((a) => a.post('/firms/:lawFirmId/things/:thingId', (req, _res, next) => {
      (req as any).user = { uid: 'user-1' };
      next();
    }, handler(async (req) => ({
      lawFirmId: req.params.lawFirmId,
      thingId: req.params.thingId,
      userId: req.user.uid,
      name: req.body.name,
    }))));
    const res = await request(app).post('/firms/firm-a/things/t-9').send({ name: 'Filing' });
    expect(res.body).toEqual({
      lawFirmId: 'firm-a', thingId: 't-9', userId: 'user-1', name: 'Filing',
    });
  });
});
