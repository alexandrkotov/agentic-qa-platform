import { join } from 'node:path';
import { rename } from 'node:fs/promises';
import type { Browser, Page } from 'playwright';
import { config } from '../config.ts';

/**
 * Shared by every SetupFn (setup/uptime-kuma.ts, setup/trilium.ts,
 * setup/nocodb.ts, and convertRecording.ts's own generated template) —
 * factored out here once a second real need (live viewing) landed on top
 * of the first (just driving the wizard headless), so the wiring for both
 * lives in one place instead of being hand-copied into every script.
 *
 * Two real, distinct capabilities, deliberately gated by the SAME single
 * `onFrame` flag rather than two separate ones — see this file's own
 * `record` local var: a human watching the "Record setup" UI's own Run
 * button always wants both live viewing (CDP screencast) and something to
 * review afterward (a saved video), never one without the other, and
 * nothing else ever asks for either (CI's own real call — see
 * admin/server.ts's /setup route — passes neither, so this whole file is
 * a complete no-op for every CI run, zero added CPU/disk/bandwidth cost).
 *
 * - Live view: `Page.startScreencast` over a raw CDP session — confirmed
 *   real via Playwright's own CDPSession docs
 *   (https://playwright.dev/docs/api/class-cdpsession), Chromium-only
 *   (the only engine this repo uses anywhere). No display server/VNC
 *   needed — this captures rendered frames directly from the headless
 *   browser's own compositor, not a window on some screen.
 * - Recording: Playwright's own `recordVideo` context option — the exact
 *   same headless capability CI test runners already rely on to capture
 *   failure videos, just pointed at a per-target subdirectory of
 *   agent-service/reports/, which is already both `.gitignore`d and
 *   bind-mounted into `workbench` (docker-compose.yml) — no new mount, no
 *   new .gitignore rule needed for this feature at all.
 */
export interface SetupPageHandle {
  page: Page;
  /** Closes the context (flushing the video file) and stops the
   *  screencast, if either was active. Returns the real saved video
   *  path, or null if no recording was requested. */
  finish(): Promise<string | null>;
}

export async function createSetupPage(
  browser: Browser,
  descriptorName: string,
  onFrame?: (base64Jpeg: string) => void,
): Promise<SetupPageHandle> {
  const record = Boolean(onFrame);
  const dir = join(config.reportsDir, 'setup-videos', descriptorName);
  const context = await browser.newContext(
    record ? { recordVideo: { dir, size: { width: 1280, height: 800 } } } : {},
  );
  const page = await context.newPage();

  let stopScreencast: (() => Promise<void>) | null = null;
  if (onFrame) {
    const client = await page.context().newCDPSession(page);
    client.on('Page.screencastFrame', (frame) => {
      onFrame(frame.data);
      // Required by CDP itself, not optional cleanup — Chrome throttles
      // and eventually stops sending further frames without an ack for
      // each one it already sent.
      client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 960,
      maxHeight: 720,
    });
    stopScreencast = async () => {
      await client.send('Page.stopScreencast').catch(() => {});
      await client.detach().catch(() => {});
    };
  }

  return {
    page,
    finish: async () => {
      await stopScreencast?.();
      await context.close(); // finalizes the video file, if any
      const video = page.video();
      if (!video) return null;
      // Playwright's own generated filename is a random hash — rename to
      // something a human can actually navigate to (and sort/find later).
      const finalPath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
      await rename(await video.path(), finalPath);
      // config.reportsDir itself is relative to this container's own
      // cwd (/usr/src/app, i.e. agent-service/ on the host) — logged as
      // the real path a human would actually navigate from the repo
      // root, not this process's own relative one, which read as
      // ambiguous ("reports/..." — reports/ under what?) when it showed
      // up in a real run's log, caught live by the user.
      return join('agent-service', finalPath);
    },
  };
}
