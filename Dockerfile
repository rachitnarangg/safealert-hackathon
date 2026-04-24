# ============================================================
# Dockerfile — SafeAlert Main Server
# ============================================================
# This file tells Docker how to package the app into a portable
# container that runs identically on any cloud platform.
# ============================================================

# ── Stage 1: Use an official lightweight Node.js base image ──
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy dependency manifests first (improves Docker layer caching)
COPY package*.json ./

# Install only production dependencies (no devDependencies)
RUN npm install --omit=dev

# Copy the rest of the application source code
COPY . .

# Tell the container that the app listens on port 3000
EXPOSE 3000

# Health check: Docker will ping /api/config every 30s to confirm the app is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/api/config || exit 1

# The command that starts the server when the container boots
CMD ["node", "server.js"]
