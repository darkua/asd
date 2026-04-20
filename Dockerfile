# syntax=docker/dockerfile:1
# JIRA AI worker — Node 22, git/gh for agent PR flow, Claude + Cursor CLIs on PATH.
# - Claude: npm global @anthropic-ai/claude-code → `claude` (AGENT_PROVIDER=claude)
# - Cursor: official `curl https://cursor.com/install | bash` → `agent` (AGENT_PROVIDER=cursor)
# Mount your target repo at REPO_PATH (see .env.example). Auth: CURSOR_API_KEY or agent login per provider docs.

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    gosu \
    git \
    ca-certificates \
    curl \
    openssh-client \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Cursor Agent CLI — same flow as https://cursor.com/docs/cli/installation (installer pins a lab build).
ARG INSTALL_CURSOR_AGENT=1
ENV CURSOR_AGENT_INSTALL_HOME=/opt/cursor-agent-home
RUN if [ "${INSTALL_CURSOR_AGENT}" = "1" ]; then \
      mkdir -p "${CURSOR_AGENT_INSTALL_HOME}" \
      && curl -fsSL https://cursor.com/install | HOME="${CURSOR_AGENT_INSTALL_HOME}" bash \
      && AGENT_BIN="$(find "${CURSOR_AGENT_INSTALL_HOME}/.local/share/cursor-agent/versions" -name cursor-agent -type f | head -n1)" \
      && test -n "${AGENT_BIN}" \
      && chmod +x "${AGENT_BIN}" \
      && ln -sf "${AGENT_BIN}" /usr/local/bin/agent; \
    fi

RUN npm install -g @anthropic-ai/claude-code

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN chown -R node:node /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Drop root after fixing /workspace permissions for Docker volume mounts (see docker-compose).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Set HEALTH_PORT in the runtime env (e.g. 8080) so load balancers can hit GET /health.
EXPOSE 8080

CMD ["node", "dist/index.js"]
