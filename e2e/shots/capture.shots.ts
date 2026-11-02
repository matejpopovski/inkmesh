import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Person, expectConverged } from '../support/board.js';

const OUTPUT = resolve(import.meta.dirname, '../../docs/screenshots');
const RETINA = 2;

function wave(x: number, y: number, length: number, height: number) {
  const points: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    points.push([x + (i / 24) * length, y + Math.sin(i / 2.6) * height + i * 0.4]);
  }
  return points;
}

/** A plan for a garden shed, drawn through the UI. Every mark is a real pointer gesture. */
async function drawScene(ana: Person, ben: Person): Promise<void> {
  await ana.ink(2);
  await ana.drawBox(150, 210, 190, 110);
  await ana.ink(1);
  await ana.page.getByTestId('toggle-fill').click();
  await ana.tool('ellipse');
  await ana.drag(470, 195, 680, 335);
  await ana.page.getByTestId('toggle-fill').click();
  await ana.ink(0);
  await ana.tool('arrow');
  await ana.drag(345, 262, 462, 262);
  await ana.ink(3);
  await ana.pencil(wave(150, 470, 300, 30));

  await ben.ink(5);
  await ben.note(860, 250, 'paint the door before the rain comes');
  await ben.ink(3);
  await ben.note(860, 480, 'ask Sam about the old timber');
  await expectConverged(ana, ben);
}

test('capture the README screenshots', async ({ browser }) => {
  const board = 'garden-shed';
  const ana = await Person.open(browser, board, 'Ana', RETINA);
  const ben = await Person.open(browser, board, 'Ben', RETINA);
  await drawScene(ana, ben);

  await ana.goOffline();
  await ana.moveBox(150, 210, 190, 20, 170);
  await ana.ink(4);
  await ana.note(600, 560, 'written with the wifi off');
  await ana.moveMouse(40, 700);

  await ben.tool('select');
  await ben.clickCanvas(245, 210);
  await ben.ink(1);
  await ben.moveBox(150, 210, 190, 300, -130);
  await ben.tool('arrow');
  await ben.drag(700, 420, 790, 300);
  await ben.deselect();

  await expect(ana.page.getByTestId('status-detail')).toContainText('waiting');
  await ana.page.waitForTimeout(100);
  await ana.page.screenshot({ path: resolve(OUTPUT, 'offline-ana.png') });
  await ben.page.screenshot({ path: resolve(OUTPUT, 'offline-ben.png') });

  await ana.goOnline();
  await expectConverged(ana, ben);
  await ana.moveMouse(330, 300);
  await ana.moveMouse(340, 306);
  await expect(ben.page.getByTestId('peer-cursor')).toContainText('Ana');
  await ben.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ben.page.waitForTimeout(150);
  await ben.page.screenshot({ path: resolve(OUTPUT, 'merged.png') });

  await ana.close();
  await ben.close();
});
