#!/bin/sh
# Runs as root (the container's default user) so it can do two things a
# non-root user can't, then hands off to the base image's built-in "node"
# user (uid/gid 1000, matching this project's own host dev user by
# coincidence -- see Dockerfile.workbench) for the actual process. Without
# this, files the container writes into bind-mounted host directories
# (descriptors/, reports/, tests/) come out root-owned on the host side,
# breaking the host user's own CLI against those same files with EACCES.
set -e

# /var/run/docker.sock is bind-mounted from the host (docker-compose.yml) so
# this container can run real `docker`/`docker compose` commands against the
# host's own daemon -- see Dockerfile.workbench's "docker-cli" build stage.
# Its group ownership on the host varies by machine (this repo's own dev
# host happens to use gid 1001, but that's not guaranteed anywhere else this
# gets cloned and run), and it's only mountable -- so only inspectable -- at
# container *start*, not at image build time. Hardcoding a gid here would
# silently break on any host where the docker group's gid differs.
if [ -S /var/run/docker.sock ]; then
  SOCK_GID="$(stat -c '%g' /var/run/docker.sock)"
  if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
    groupadd -g "$SOCK_GID" dockerhost
  fi
  # setpriv execs the target directly (no wrapper process left running as
  # root), so signal handling (docker compose stop/down) reaches the real
  # process exactly like it would running unprivileged in the first place.
  # --reset-env: also fixes HOME (root -> /home/node), which matters here
  # specifically because the playwright-browsers volume is now mounted at
  # /home/node/.cache/ms-playwright, not /root/.cache/ms-playwright -- see
  # docker-compose.yml. Without this, Playwright would resolve its cache
  # path against the wrong (root's) HOME even after the uid/gid switch.
  exec setpriv --reuid=node --regid=node --groups "$SOCK_GID" --reset-env "$@"
else
  exec setpriv --reuid=node --regid=node --clear-groups --reset-env "$@"
fi
