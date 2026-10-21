# Builds the site and serves it with nginx. Built from the repo root
# (docker-compose.yml), since client/package.json depends on the root package.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json client/
RUN cd client && npm ci
COPY client client
RUN cd client && npm run build

FROM nginx:alpine
COPY --from=build /app/client/dist /usr/share/nginx/html
