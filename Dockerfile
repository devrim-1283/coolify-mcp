# syntax=docker/dockerfile:1

# coolify-mcp over Streamable HTTP — the image that makes `serve --http`
# deployable, including on Coolify itself.
#
#   docker build -t coolify-mcp .
#   docker run --rm -p 127.0.0.1:3000:3000 \
#     -e COOLIFY_BASE_URL=https://coolify.example.com \
#     -e COOLIFY_API_TOKEN='13|…' \
#     -e COOLIFY_MCP_AUTH_TOKEN="$(openssl rand -base64 32)" \
#     -e COOLIFY_READ_ONLY=true \
#     coolify-mcp
#
# Deployment, TLS, and the --allowed-host you will need behind a reverse
# proxy: docs/deploy.md.

# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------
# Node 22 because that is the version CI lints, type-checks and packages with.
# The test matrix covers 20, 22 and 24, so any of them would run; 22 is the one
# the published artefact is proven against on every commit.
#
# Alpine is safe here for a specific reason rather than out of habit: this
# package has no native dependencies, ever (README → Requirements). A tree of
# five pure-JS runtime dependencies cannot care whether libc is musl or glibc.
#
# Pinned by tag AND digest. The tag alone floats — `node:22-alpine` resolves to
# a different image every few weeks, so the same commit would produce two
# different runtimes and a build that worked yesterday can fail today with
# nothing in the diff to blame. The digest is the multi-arch *index*, not one
# platform's manifest, so arm64 hosts (a large share of Coolify fleets) still
# resolve their own layer.
#
# The price of a digest pin is that base-image CVE fixes now arrive only when a
# human bumps this line. That is the trade being made deliberately: bump it on a
# schedule and let Dependabot open the PR, rather than let an unreviewed base
# image arrive at 3am.
#
# NODE_ENV is deliberately NOT set here. npm reads it, and `NODE_ENV=production`
# would make the build stage's `npm ci` skip devDependencies — no tsup, no
# build. It is set in the runtime stage only.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# Build — the full dependency tree, compiled, then discarded
# ---------------------------------------------------------------------------
FROM base AS build

# Manifests first so that editing source does not invalidate the install layer.
COPY package.json package-lock.json ./

# Lifecycle scripts run here on purpose: esbuild, which tsup drives, links its
# platform binary in a postinstall. Nothing from this stage reaches the final
# image, so what runs here never becomes runtime surface.
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime dependencies — installed apart so npm's cache never lands in a layer
# that ships
# ---------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./

# tsup bundles zod, smol-toml, jsonc-parser and yaml into dist/, but
# `@modelcontextprotocol/sdk` is listed in `external` in tsup.config.ts — it is
# resolved from node_modules at startup and the process does not run without it.
#
# Installing the whole declared production set rather than that one package
# keeps the install reproducible from the lockfile, and means a later change to
# `external` cannot produce an image that builds clean and crashes on the first
# request.
#
# --ignore-scripts: none of the five have install scripts, and a dependency that
# starts running one is a supply-chain event, not a build detail.
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

# tini as PID 1. Two reasons, and only the second one is unconditional:
#
#   - PID 1 does not get the kernel's default signal action, so a process that
#     installs no SIGTERM handler ignores SIGTERM entirely and `docker stop`
#     spends the whole grace period before SIGKILL. `serve --http` does install
#     one (`runUntilSignal` in src/cli.ts), so today node would stop cleanly as
#     PID 1 — measured at 0.3s with tini and 0.3s without. tini is what keeps
#     that true if the handler is ever refactored away, and what makes it true
#     for any other command someone runs in this image.
#   - PID 1 is also the only process that reaps orphans, and this server does
#     fork children: `tokenCommand` runs `op` / `pass` / `vault` / `security`
#     through execFile. Nothing in Node reaps a grandchild, so without an init
#     they accumulate as zombies for the life of the container.
#
# `docker run --init` and compose's `init: true` do the same job, but they are
# the operator's flag to forget. Baking it in makes the image correct however it
# is started. Unversioned on purpose: the base is digest-pinned, so this is the
# one line that still picks up an Alpine security update on rebuild.
RUN apk add --no-cache tini

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# package.json is required at runtime, not a convenience: `type: "module"` is
# what makes dist/*.js load as ESM, and both src/server.ts and src/cli.ts read
# the version out of it through createRequire('../package.json').
COPY package.json ./

# The official Node image already ships a non-root `node` user at uid/gid 1000.
# Use it rather than creating a second identity at the same uid — an extra
# adduser here buys nothing and only makes host-side uid mapping harder to
# reason about.
#
# Nothing is chowned. The process only ever reads /app, so leaving the tree
# owned by root means a compromised process cannot rewrite its own code.
USER node

# The port is fixed at 3000 inside the container. Publish a different port on
# the host if you need one; there is no reason to renumber the inside of a
# network namespace that contains exactly one process.
EXPOSE 3000

# `/healthz` is unauthenticated by design: the health check does not hold the
# bearer token and could not be given one, and the endpoint reveals only that a
# process is listening — no connection names, no version, no configuration.
#
# wget, not curl: busybox wget is already in the base image and curl is not.
# Adding curl to issue one GET would be megabytes of extra attack surface.
#
# `-O /dev/null` rather than `--spider`, which in busybox sends HEAD.
# `handleHealth` answers HEAD too, so either works — but a health check should
# take the same path a load balancer takes rather than a second branch that
# happens to exist.
#
# 127.0.0.1 because the check runs inside this container's own network
# namespace; nothing outside it can reach that address. /healthz is routed
# before any Host or Origin validation, so this stays green whatever
# `--allowed-host` is set to.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --output-document=/dev/null http://127.0.0.1:3000/healthz || exit 1

# Exec form, with tini in front. A shell-form CMD would put `/bin/sh -c`
# between tini and node, and sh does not forward signals to its child —
# `docker stop` would hit the shell and leave node running until the SIGKILL.
ENTRYPOINT ["/sbin/tini", "--"]

# --host 0.0.0.0 is correct HERE and wrong nearly everywhere else.
#
# The server binds 127.0.0.1 by default precisely so that it cannot be reached
# from the network by accident. Inside a container that default is unusable:
# loopback in this namespace is reachable only by this container, so a server
# bound to it answers the health check and nothing else — not the published
# port, not Traefik, not another container. The container is the network
# boundary, so binding every interface inside it exposes exactly as much as the
# `ports`/`expose` declaration says and no more.
#
# If you copy this flag onto a host shell, you have published a server holding a
# live Coolify token on every interface of that machine. Do not.
#
# One flag is deliberately absent here and present in docker-compose.yml: a
# wildcard bind cannot predict the Host header, so the derived allow list is
# empty and Host validation is skipped — the server says exactly that on stderr
# at startup. Add `--allowed-host <public hostname>` to switch it back on. There
# is no hostname an image can guess, which is why the compose file asks for it.
CMD ["node", "dist/cli.js", "serve", "--http", "--host", "0.0.0.0", "--port", "3000"]
