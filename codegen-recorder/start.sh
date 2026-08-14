#!/bin/bash
# Boots the idle "shell" this whole service is built around — virtual display + window manager +
# VNC + noVNC — and then just waits. No browser starts here on purpose: `playwright codegen` itself
# is launched later, per real recording request, via `docker exec` from admin/server.ts's own
# /api/recorder/start route — that's what keeps this container cheap to leave running all the time
# (see this repo's own docker-compose.yml comment on the codegen-recorder service for the resource
# argument that shaped this).
set -e

export DISPLAY=:99

Xvfb :99 -screen 0 1280x800x24 &
sleep 1

# A real random password, generated fresh every container start — never a hardcoded/default value
# (the actual, concrete answer to "could this be a security hole," not a hand-wave). Printed to the
# container's own log, not written anywhere else — admin/server.ts's /api/recorder/start route
# parses it back out of `docker logs` on demand rather than storing it separately, so there is
# exactly one source of truth for what x11vnc is actually enforcing.
VNC_PASSWORD=$(head -c 16 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
echo "VNC password: ${VNC_PASSWORD}"
mkdir -p /root/.vnc
x11vnc -storepasswd "${VNC_PASSWORD}" /root/.vnc/passwd

fluxbox &
sleep 1

x11vnc -display :99 -forever -shared -rfbauth /root/.vnc/passwd -rfbport 5900 &

# Foreground — this is the process docker-compose.yml's own healthcheck/logs watch, and what keeps
# the container alive between recording sessions.
exec websockify --web /usr/share/novnc 6080 localhost:5900
