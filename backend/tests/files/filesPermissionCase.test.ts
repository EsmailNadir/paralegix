/**
 * The files permission gate must not be bypassable by changing the case of the
 * path, and must not fail open on a path it does not recognise.
 *
 * Every files permission in this app is enforced by ONE lookup:
 *
 *     const required = routePermissions.get(`${req.method} ${rawPath}`);
 *     if (!required) return next();
 *
 * Two properties of Express make that dangerous. Routing is case-INSENSITIVE by
 * default, and no router here passes `{ caseSensitive: true }`, so `/Delete`
 * reaches the `/delete` handler while `req.path` is still `/Delete`. And the
 * miss branch is `return next()`, which fails OPEN.
 *
 * Together those meant a caller could drop every files permission by changing
 * one letter: `files.view`, `files.upload`, `files.delete` and
 * `files.manageFolders` were all unenforceable, and the role editor showed the
 * firm a control that did nothing. The scope checks in `resolveFileScope` still
 * ran, so this was never cross-tenant, but it was a complete RBAC bypass on the
 * storage surface.
 *
 * The mixed-case cases below are the regression. The unmapped-path case pins the
 * other half: a path the map does not know must be refused, not waved through,
 * so a route added later without a map entry fails closed.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  drainEvents,
  createFirm,
  memberWith,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';

let firm: Firm;
let owner: Actor;
let viewer: Actor;   // may read files, may not write them

const base = () => `/api/lawfirms/${firm.id}/files`;

async function seedMatter(uid: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, status)
     values ($1, $2, 'Files matter', $3, 'active')`,
    [id, firm.id, `REF-${id.slice(0, 8)}`],
  );
  await testPool.query(
    `insert into matter_members (law_firm_id, matter_id, user_id, role, joined_at)
     values ($1, $2, $3, 'lead', now())`,
    [firm.id, id, uid],
  );
  return id;
}

beforeEach(async () => {
  firm = await createFirm();
  owner = await ownerOf(firm.id);
  // files.view but NOT files.delete / files.upload / files.manageFolders.
  viewer = await memberWith(firm.id, ['files.view', 'matters.view']);
  await drainEvents();
});

describe('the permission gate is not case-sensitive to its own advantage', () => {
  it('refuses a delete the caller lacks permission for, in lower case', async () => {
    const matterId = await seedMatter(viewer.uid);

    const res = await viewer.api.delete(`${base()}/delete`)
      .query({ matterId, fileObjectPath: `lawfirmids/${firm.id}/${matterId}/a.pdf` });

    // The baseline. Without this passing, the mixed-case cases below prove
    // nothing: they could be refused for some entirely different reason.
    expect(res.status).toBe(403);
  });

  it('refuses the SAME delete when the path is capitalised', async () => {
    const matterId = await seedMatter(viewer.uid);

    const res = await viewer.api.delete(`${base()}/Delete`)
      .query({ matterId, fileObjectPath: `lawfirmids/${firm.id}/${matterId}/a.pdf` });

    // Express routes `/Delete` to the `/delete` handler, but `req.path` keeps
    // the capital, so the map lookup missed and the gate waved it through.
    expect(res.status).toBe(403);
  });

  it('refuses it in upper case too', async () => {
    const matterId = await seedMatter(viewer.uid);

    const res = await viewer.api.delete(`${base()}/DELETE`)
      .query({ matterId, fileObjectPath: `lawfirmids/${firm.id}/${matterId}/a.pdf` });

    expect(res.status).toBe(403);
  });

  it('refuses a capitalised folder create', async () => {
    const matterId = await seedMatter(viewer.uid);

    const res = await viewer.api.post(`${base()}/Create-Folder`)
      .send({ matterId, folderPath: `lawfirmids/${firm.id}/${matterId}/New Folder` });

    // A different permission code (files.manageFolders) through the same gate,
    // so the fix cannot be a special case for one route.
    expect(res.status).toBe(403);
  });

  it('refuses a capitalised client-visibility change', async () => {
    const matterId = await seedMatter(viewer.uid);

    const res = await viewer.api.patch(`${base()}/Client-Visibility`)
      .send({
        matterId,
        fileObjectPath: `lawfirmids/${firm.id}/${matterId}/a.pdf`,
        clientVisible: true,
      });

    // The sharpest of the set: this publishes a matter document into the client
    // portal, and it was reachable without files.upload.
    expect(res.status).toBe(403);
  });
});

describe('a caller who HOLDS the permission is unaffected', () => {
  // These assert NOT-403 rather than a 2xx on purpose. The list handler reaches
  // GCS, which the harness stubs to throw by name, so a permitted caller lands
  // on a 500 from the storage stub. That is still decisive for what is under
  // test: reaching the handler at all means the permission gate allowed them.
  it('lets an owner past the gate on the ordinary lower-case path', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await owner.api.get(`${base()}/list`).query({ matterId });

    // The half that keeps every case above honest. A gate that refused
    // everything, or one that refused all mixed case outright, would satisfy
    // them and break the feature.
    expect(res.status).not.toBe(403);
  });

  it('lets an owner past the gate on a capitalised path too', async () => {
    const matterId = await seedMatter(owner.uid);

    const res = await owner.api.get(`${base()}/List`).query({ matterId });

    // Express already routes this to the handler, so the gate must resolve the
    // same permission and ALLOW it. Refusing mixed case outright would be a
    // different bug: it would break any caller whose client normalises URLs.
    expect(res.status).not.toBe(403);
  });
});

describe('an unmapped path fails closed', () => {
  it('refuses a files path the permission map does not know', async () => {
    const res = await viewer.api.get(`${base()}/not-a-real-files-route`);

    // The miss branch used to be `return next()`, so a files route declared
    // without a Map entry carried no permission check at all and nothing
    // reported it. It now refuses, which is what keeps the Map honest: the next
    // route added without an entry fails visibly on itself rather than shipping
    // open.
    //
    // 403 rather than 404 is the point. This path reaches no handler either way,
    // so a 404 would prove nothing about the gate; the 403 says the gate ran and
    // declined to guess.
    expect(res.status).toBe(403);
  });

  it('refuses an unmapped path even for the OWNER', async () => {
    const res = await owner.api.get(`${base()}/not-a-real-files-route`);

    // Deliberately not an owner exemption. The point is that an unclassified
    // route is refused until somebody classifies it, and an owner-shaped hole
    // would hide exactly the case this is meant to surface.
    expect(res.status).toBe(403);
  });
});

describe('every route behind the gate has a permission entry', () => {
  // The Map is only load-bearing if it is COMPLETE, and completeness is the one
  // property neither files.routes nor the four sub-routers can show on their
  // own. This walks the composed stack and compares it against the Map itself,
  // so a route added without an entry fails HERE, naming itself, rather than
  // being discovered later as a mystery 403 by whoever calls it.
  it('leaves no route behind enforceFilesPermission unmapped', () => {
    const filesRouter = require('../../src/modules/files/files.routes');
    const map = (filesRouter as any).routePermissions as Map<string, unknown>;
    expect(map).toBeInstanceOf(Map);

    const paths: string[] = [];
    const walk = (layer: any) => {
      if (layer.route?.path) {
        for (const [method, on] of Object.entries(layer.route.methods || {})) {
          if (on) paths.push(`${method.toUpperCase()} ${layer.route.path}`);
        }
      }
      for (const inner of layer.handle?.stack || []) walk(inner);
    };
    for (const layer of filesRouter.stack || []) walk(layer);

    // `GET /` declares its own requirePermission above the gated mount, so it is
    // the one legitimate exclusion.
    const gated = paths.filter((p) => p !== 'GET /');

    // Guards the walk itself. If the router shape changes and this stops finding
    // routes, an empty `unmapped` below would pass for entirely the wrong reason.
    // Lowered from 18 when the two multipart attachment routes were removed in
    // favour of the shared `upload-init` / `upload-finalize` pair.
    expect(gated.length).toBeGreaterThanOrEqual(17);

    const unmapped = gated.filter((p) => !map.has(p.toLowerCase().replace(/^([a-z]+) /, (_m, verb) => `${verb.toUpperCase()} `)));
    expect(unmapped).toEqual([]);
  });

  it('has no Map entry for a route that no longer exists', () => {
    const filesRouter = require('../../src/modules/files/files.routes');
    const map = (filesRouter as any).routePermissions as Map<string, unknown>;

    const paths = new Set<string>();
    const walk = (layer: any) => {
      if (layer.route?.path) {
        for (const [method, on] of Object.entries(layer.route.methods || {})) {
          if (on) paths.add(`${method.toUpperCase()} ${layer.route.path}`);
        }
      }
      for (const inner of layer.handle?.stack || []) walk(inner);
    };
    for (const layer of filesRouter.stack || []) walk(layer);

    // The other direction. A stale entry is harmless at runtime but it makes the
    // Map lie about what the module exposes, and it is how someone concludes a
    // route is protected when it was deleted years ago.
    const orphans = [...map.keys()].filter((k) => !paths.has(k as string));
    expect(orphans).toEqual([]);
  });
});
