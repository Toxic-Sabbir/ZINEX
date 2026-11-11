# Local mirror of the Coco AI frontend plus a self-contained mock backend.
#
# The image serves the mirrored static site AND emulates the Firebase Auth /
# Realtime Database and /api endpoints the frontend expects, so registration,
# login and every internal interface work offline with dummy credentials.
# Nothing here talks to the real Firebase project.

FROM node:22-alpine

ENV NODE_ENV=production
# Railway injects PORT at runtime; default to 8080 for local runs.
ENV PORT=8080

WORKDIR /app

# Install the mock backend's dependencies (only `ws`) in a cached layer.
COPY mock-server/package.json mock-server/package-lock.json ./mock-server/
RUN cd mock-server && npm ci --omit=dev

# Static site (served by the mock backend) and the backend itself.
COPY . .
RUN rm -f /app/Dockerfile /app/.dockerignore

EXPOSE 8080
CMD ["node", "mock-server/server.js"]
