import { expect, test } from '@playwright/test';
import { Person, expectConverged } from './support/board.js';
import { ensureServer, killServer, startServer } from './support/server.js';

const uniqueBoard = (name: string) => `${name}-${Date.now().toString(36)}`;

test.afterEach(ensureServer);

test.describe('two browsers, one offline', () => {
  test('conflicting offline edits converge after reconnect', async ({ browser }) => {
    const board = uniqueBoard('conflict');
    const ana = await Person.open(browser, board, 'Ana');
    const ben = await Person.open(browser, board, 'Ben');

    await ana.drawBox(100, 120, 160, 100);
    await ana.ink(1);
    await ana.drawBox(420, 120, 160, 100);
    await ana.ink(0);
    await ana.drawBox(760, 120, 160, 100);
    await ben.drawBox(100, 420, 160, 100);
    await expectConverged(ana, ben);
    const [left, middle, right, lower] = await ana.shapes();

    await ana.goOffline();
    // Evidence that the cut is real: the server has told Ben that Ana has gone.
    await expect(ben.page.getByRole('listitem').filter({ hasText: 'Ana' })).toHaveCount(0);

    // Same field, both sides. Ana edits first, so Ben holds the later stamp and should win.
    await ana.moveBox(100, 120, 160, 0, 90);
    await ana.page.waitForTimeout(30);
    await ben.moveBox(100, 120, 160, 0, 200);

    // Different fields of one shape: both must survive.
    await ana.moveBox(420, 120, 160, 40, 60);
    await ben.clickSelectAndRecolor(500, 120, 3);

    // Ana edits a shape that Ben deletes: delete wins.
    await ben.tool('select');
    await ben.clickCanvas(840, 120);
    await ben.page.keyboard.press('Delete');
    await ana.moveBox(760, 120, 160, 0, 300);

    // Plain additions on both sides.
    await ana.note(640, 620, 'made offline');
    await ben.tool('ellipse');
    await ben.drag(960, 300, 1100, 420);

    // Ana cannot see any of Ben's work, and Ben sees none of hers.
    await expect(ana.page.getByTestId('status')).toHaveAttribute('data-status', 'offline');
    expect(
      Number(await ana.page.getByTestId('status').getAttribute('data-unsent')),
    ).toBeGreaterThan(0);
    expect((await ben.shapes()).some((shape) => shape.kind === 'note')).toBe(false);
    expect((await ana.shapes()).some((shape) => shape.kind === 'ellipse')).toBe(false);

    await ana.goOnline();
    await expectConverged(ana, ben);

    const merged = await ben.shapes();
    const byId = new Map(merged.map((shape) => [shape.id, shape]));
    expect(byId.get(left?.id as string)?.pos).toEqual([100, 320]);
    expect(byId.get(middle?.id as string)?.pos).toEqual([460, 180]);
    expect(byId.get(middle?.id as string)?.color).toBe('#4c6b37');
    expect(byId.has(right?.id as string)).toBe(false);
    expect(byId.has(lower?.id as string)).toBe(true);
    expect(merged.find((shape) => shape.kind === 'note')?.text).toBe('made offline');
    expect(merged.some((shape) => shape.kind === 'ellipse')).toBe(true);

    await ana.close();
    await ben.close();
  });

  test('an offline writer with the later stamp wins the same field', async ({ browser }) => {
    const board = uniqueBoard('late-writer');
    const ana = await Person.open(browser, board, 'Ana');
    const ben = await Person.open(browser, board, 'Ben');
    await ana.drawBox(100, 120, 160, 100);
    await expectConverged(ana, ben);
    const [shape] = await ana.shapes();

    await ana.goOffline();
    await ben.moveBox(100, 120, 160, 0, 200);
    await ben.page.waitForTimeout(30);
    await ana.moveBox(100, 120, 160, 300, 50);
    await ana.goOnline();
    await expectConverged(ana, ben);

    expect((await ben.shapes()).find((item) => item.id === shape?.id)?.pos).toEqual([400, 170]);
    await ana.close();
    await ben.close();
  });

  test('offline work survives a reload with no network', async ({ browser }) => {
    const board = uniqueBoard('reload');
    const ana = await Person.open(browser, board, 'Ana');
    const ben = await Person.open(browser, board, 'Ben');
    await ana.waitForOfflineShell();
    await ana.drawBox(100, 120, 160, 100);
    await expectConverged(ana, ben);

    await ana.goOffline();
    await ana.note(500, 300, 'still here');
    await ana.page.evaluate(() => window.__inkmesh.flush());
    await ana.page.reload();
    await ana.expectStatus('offline');

    const restored = await ana.shapes();
    expect(restored.map((shape) => shape.kind)).toEqual(['rect', 'note']);
    expect(restored[1]?.text).toBe('still here');

    await ben.drawBox(700, 500, 120, 90);
    await ana.goOnline();
    await expectConverged(ana, ben);
    expect((await ben.shapes()).find((shape) => shape.kind === 'note')?.text).toBe('still here');
    await ana.close();
    await ben.close();
  });
});

test.describe('server failure', () => {
  test('a killed server loses nothing and clients carry on', async ({ browser }) => {
    const board = uniqueBoard('crash');
    const ana = await Person.open(browser, board, 'Ana');
    const ben = await Person.open(browser, board, 'Ben');
    await ana.drawBox(100, 120, 160, 100);
    await expectConverged(ana, ben);

    await killServer();
    await ana.expectStatus('connecting');
    await ana.drawBox(420, 120, 160, 100);
    await ben.drawBox(100, 420, 160, 100);

    await startServer();
    await ana.expectStatus('online');
    await ben.expectStatus('online');
    await expectConverged(ana, ben);
    expect(await ben.shapes()).toHaveLength(3);

    const late = await Person.open(browser, board, 'Cleo');
    expect(await late.visibleState()).toBe(await ana.visibleState());
    await late.close();
    await ana.close();
    await ben.close();
  });
});

test.describe('live collaboration', () => {
  test('shows a collaborator cursor and a shape being dragged', async ({ browser }) => {
    const board = uniqueBoard('live');
    const ana = await Person.open(browser, board, 'Ana');
    const ben = await Person.open(browser, board, 'Ben');
    await ana.drawBox(200, 200, 160, 100);
    await expectConverged(ana, ben);

    await ana.moveMouse(600, 400);
    await ana.moveMouse(620, 410);
    const cursor = ben.page.getByTestId('peer-cursor');
    await expect(cursor).toContainText('Ana');

    await ana.tool('select');
    await ana.moveMouse(280, 200);
    await ana.page.mouse.down();
    await ana.moveMouse(280, 300);
    await expect
      .poll(async () => (await ben.shapes())[0]?.pos, { message: 'Ben should see the drag live' })
      .toEqual([200, 300]);
    await ana.page.mouse.up();

    await ana.close();
    await expect(cursor).toHaveCount(0);
    await ben.close();
  });

  test('undo in one browser reaches the other, even for a delete', async ({ browser }) => {
    const board = uniqueBoard('undo');
    const ana = await Person.open(browser, board, 'Ana');
    const ben = await Person.open(browser, board, 'Ben');
    await ana.drawBox(200, 200, 160, 100);
    await expectConverged(ana, ben);

    await ana.tool('select');
    await ana.clickCanvas(280, 200);
    await ana.page.keyboard.press('Delete');
    await expect.poll(async () => (await ben.shapes()).length).toBe(0);

    await ana.page.getByTestId('undo').click();
    await expect.poll(async () => (await ben.shapes()).length).toBe(1);
    await expectConverged(ana, ben);
    await ana.close();
    await ben.close();
  });
});
