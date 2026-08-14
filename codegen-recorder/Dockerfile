# A real, headed Chromium + Playwright Inspector, watchable/clickable from a plain browser tab
# over noVNC — no native VNC client, no display server on the host. Confirmed live in a throwaway
# spike before this became a real platform service (see memory `project_setup_script_autogen_idea`
# for the full account): the base image below already ships Chromium plus every OS dependency a
# *headed* (not headless) browser needs — this project's other Playwright users
# (agent-service/Dockerfile.workbench, the tests/ suite) only ever run headless, so they don't need
# any of this; this is the one place in the repo that deliberately does.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# xvfb — the virtual display Chromium actually renders into (no real GPU/monitor needed).
# x11vnc — shares that virtual display over the VNC protocol.
# novnc + websockify — turn raw VNC into a plain website (a <canvas> + JS), so admin/server.ts's
#   own "Record setup" view can embed it in an <iframe> with zero native client on the human's side.
# fluxbox — a minimal window manager; without one, Chromium's own window has no title bar/borders
#   and some dialogs render oddly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
# Deliberately a fresh local install, not relying on anything baked into the base image's own
# global state — confirmed live this is what the base image actually expects (its own Chromium
# install needs a matching `playwright` package version driving it).
RUN npm init -y && npm install playwright@1.55.0 && npx playwright install chromium

COPY start.sh /start.sh
RUN chmod +x /start.sh

# 6080 only — no VNC-native 5900 published (docker-compose.yml keeps it internal, x11vnc's own
# raw protocol never needs to reach the host directly, only through the noVNC web wrapper above).
EXPOSE 6080
CMD ["/start.sh"]
