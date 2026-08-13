#!/bin/sh
# Runs as root (the container's default user) so it can do two things a
# non-root user can't, then hands off to the base image's built-in "node"
# user (uid/gid 1000, matching this project's own host dev user by
# coincidence -- see Dockerfile.workbench) for the actual process. Without
# this, files the container writes into bind-mounted host directories
# (descriptors/, reports/, tests/) come out root-owned on the host side,
# breaking the host user's own CLI against those same files with EACCES.
set -e

# /home/node/.cache itself (not the ms-playwright volume mounted inside it —
# that one's already node-owned) comes out root-owned: Docker creates
# missing parent directories for a volume mount as root, before this
# entrypoint ever runs, the same class of bug documented for bind-mounted
# host directories above. Harmless as long as nothing needs to create a
# NEW sibling directory directly under .cache — until playwright-mcp's own
# browser session tried to, and failed outright with "EACCES: permission
# denied, mkdir '/home/node/.cache/ms-playwright-mcp'" on every single
# tool call (confirmed live, 2026-08-09, running Discovery against a
# docker-compose-deployed target). A plain chown (not -R — the ms-playwright
# subtree is already correctly owned and can be large) is enough.
if [ -d /home/node/.cache ]; then
  chown node:node /home/node/.cache
fi

# Every OTHER bind-mounted host directory this container writes real files
# into (docker-compose.yml) — same root-owned-by-default class of bug as
# /home/node/.cache above, just never noticed here until CI actually
# exercised it: this repo's own dev host happens to share uid 1000 with
# the "node" user below (pure coincidence, already called out in the
# top-of-file comment), so every one of these silently worked by luck, not
# by design. A real GitHub Actions runner's checkout is owned by uid 1001
# ("runner"), not 1000 — confirmed live, hit this exact bug twice in a
# row for two different mounts before catching that it's systemic:
# bootstrap/deployTarget.ts's own assertMirroredMount() failed outright on
# targets/ ("EACCES ... open '.../targets/.mirror-check-...'"), then the
# very next successful deploy immediately hit the identical failure
# writing into tests/ ("EACCES ... mkdir '.../tests/.features-gen/features'"
# from playwright-bdd's own generator, then again writing tests/reports/
# from support/generate-html-report.mjs). Fixing every mount in one pass
# here rather than waiting for each to fail in its own separate CI run.
# Both -R and an unconditional mkdir -p matter for every entry, not just
# whichever one first triggered this: real content gets generated into NEW
# subdirectories at arbitrary depth (tests/.features-gen/, tests/reports/,
# agent-service/reports/*.json, archive/bdd-test-suite-*/, ...), so the
# top-level directory alone being node-owned isn't enough; and several of
# these (archive/, targets/, agent-service/reports/, tests/.features-gen/,
# tests/reports/) are gitignored, so a fresh GitHub Actions checkout has
# NONE of them yet — a plain `[ -d ]` existence guard would silently skip
# exactly the ones most likely to hit this bug.
for dir in \
  /usr/src/app/descriptors \
  /usr/src/app/reports \
  /usr/src/app/archive \
  /usr/src/app/tests \
  /usr/src/app/src/bootstrap/setup \
  "${HOST_PROJECT_ROOT:+$HOST_PROJECT_ROOT/targets}"; do
  if [ -n "$dir" ]; then
    mkdir -p "$dir"
    chown -R node:node "$dir"
  fi
done

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
  #
  # HOME is overridden by hand (root -> /home/node) rather than via
  # setpriv's own --reset-env, which matters here specifically because the
  # playwright-browsers volume is mounted at /home/node/.cache/ms-playwright,
  # not /root/.cache/ms-playwright -- see docker-compose.yml. Without a
  # correct HOME, Playwright would resolve its cache path against root's
  # HOME even after the uid/gid switch.
  #
  # --reset-env itself is deliberately NOT used: found live (2026-08-07)
  # that it wipes the ENTIRE environment down to just
  # HOME/SHELL/USER/LOGNAME/PATH, silently dropping every docker-compose
  # env_file variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_MODEL,
  # etc.) before the real node process ever starts -- confirmed via
  # `setpriv ... --reset-env env` printing only those 5 vars. This broke
  # every real Claude/OpenAI call made through this container (Discovery,
  # Stage 2 generate, workflow-propose, E2E diagnose) since this fix
  # originally landed, unnoticed because later live checks either didn't
  # need a *new* paid call (reused an already-approved proposal) or used a
  # free/mechanical diagram path with no LLM call at all. Exporting HOME by
  # hand and dropping --reset-env keeps the rest of the container's
  # environment (including env_file) intact.
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --groups "$SOCK_GID" "$@"
else
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --clear-groups "$@"
fi
