import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface ShapeView {
  id: string;
  kind: string;
  pos: [number, number];
  size?: [number, number];
  color: string;
  text?: string;
  fill?: boolean;
}

declare global {
  interface Window {
    __inkmesh: {
      replica: string;
      visibleState(): string;
      shapes(): ShapeView[];
      stats(): { live: number; tombstones: number; registers: number; replicas: number };
      pending(): number;
      flush(): Promise<void>;
      selection(): string | null;
    };
  }
}

/** One person: a real browser context with its own storage, driven through real input events. */
export class Person {
  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {}

  static async open(browser: Browser, board: string, name: string, scale = 1): Promise<Person> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: scale,
    });
    await context.addInitScript((value) => localStorage.setItem('inkmesh.name', value), name);
    const page = await context.newPage();
    const person = new Person(context, page);
    await page.goto(`/b/${board}`);
    await person.expectStatus('online');
    return person;
  }

  private get canvas() {
    return this.page.getByTestId('board-canvas');
  }

  async expectStatus(status: 'online' | 'offline' | 'connecting'): Promise<void> {
    await expect(this.page.getByTestId('status')).toHaveAttribute('data-status', status);
  }

  private async toPage(x: number, y: number): Promise<[number, number]> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error('board canvas is not visible');
    return [box.x + x, box.y + y];
  }

  async tool(name: string): Promise<void> {
    await this.page.getByTestId(`tool-${name}`).click();
  }

  async ink(index: number): Promise<void> {
    await this.page.getByTestId(`ink-${index}`).click();
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.page.mouse.move(...(await this.toPage(fromX, fromY)));
    await this.page.mouse.down();
    await this.page.mouse.move(...(await this.toPage((fromX + toX) / 2, (fromY + toY) / 2)), {
      steps: 4,
    });
    await this.page.mouse.move(...(await this.toPage(toX, toY)), { steps: 4 });
    await this.page.mouse.up();
  }

  async drawBox(x: number, y: number, w: number, h: number): Promise<void> {
    await this.tool('rect');
    await this.drag(x, y, x + w, y + h);
  }

  async clickCanvas(x: number, y: number): Promise<void> {
    await this.page.mouse.click(...(await this.toPage(x, y)));
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.page.mouse.move(...(await this.toPage(x, y)));
  }

  async doubleClickCanvas(x: number, y: number): Promise<void> {
    await this.page.mouse.dblclick(...(await this.toPage(x, y)));
  }

  /** Grabs a box by its top edge and drags it, using only pointer input. */
  async moveBox(x: number, y: number, w: number, dx: number, dy: number): Promise<void> {
    await this.tool('select');
    const grabX = x + w / 2;
    await this.drag(grabX, y, grabX + dx, y + dy);
  }

  /** Draws freehand through `points`, with extra samples so the pencil gets a natural line. */
  async pencil(points: readonly (readonly [number, number])[]): Promise<void> {
    await this.tool('pen');
    const [first, ...rest] = points as [readonly [number, number], ...[number, number][]];
    await this.page.mouse.move(...(await this.toPage(first[0], first[1])));
    await this.page.mouse.down();
    for (const [x, y] of rest) {
      await this.page.mouse.move(...(await this.toPage(x, y)), { steps: 3 });
    }
    await this.page.mouse.up();
  }

  async clickSelectAndRecolor(x: number, y: number, ink: number): Promise<void> {
    await this.tool('select');
    await this.clickCanvas(x, y);
    await this.ink(ink);
  }

  async note(x: number, y: number, text: string): Promise<void> {
    await this.tool('note');
    await this.clickCanvas(x, y);
    await this.page.getByTestId('note-editor').pressSequentially(text);
    await this.page.keyboard.press('Escape');
  }

  async deselect(): Promise<void> {
    await this.tool('select');
    await this.page.keyboard.press('Escape');
    await this.page.mouse.move(2, 2);
  }

  shapes(): Promise<ShapeView[]> {
    return this.page.evaluate(() => window.__inkmesh.shapes());
  }

  visibleState(): Promise<string> {
    return this.page.evaluate(() => window.__inkmesh.visibleState());
  }

  /** The canvas contents as a PNG data URL: exact pixels, without any page chrome or cursors. */
  pixels(): Promise<string> {
    return this.canvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL('image/png'));
  }

  async goOffline(): Promise<void> {
    await this.context.setOffline(true);
    await this.expectStatus('offline');
  }

  async goOnline(): Promise<void> {
    await this.context.setOffline(false);
    await this.expectStatus('online');
  }

  async waitForOfflineShell(): Promise<void> {
    await this.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      if (!registration.active) throw new Error('no active service worker');
    });
  }

  close(): Promise<void> {
    return this.context.close();
  }
}

/** Waits until both people hold the same board, have nothing unsent, and show the same pixels. */
export async function expectConverged(a: Person, b: Person): Promise<void> {
  await expect
    .poll(async () => (await a.visibleState()) === (await b.visibleState()), {
      message: 'documents should converge',
    })
    .toBe(true);
  await expect
    .poll(() => a.page.evaluate(() => window.__inkmesh.pending()), { message: 'a has unsent work' })
    .toBe(0);
  await expect
    .poll(() => b.page.evaluate(() => window.__inkmesh.pending()), { message: 'b has unsent work' })
    .toBe(0);
  await a.deselect();
  await b.deselect();
  await expect
    .poll(async () => (await a.pixels()) === (await b.pixels()), {
      message: 'both canvases should show identical pixels',
    })
    .toBe(true);
}
