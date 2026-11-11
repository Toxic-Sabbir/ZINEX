FROM nginx:1.27-alpine

# Railway injects PORT at runtime; default to 8080 for local runs.
ENV PORT=8080

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY . /usr/share/nginx/html

# Drop files that must not be served to browsers.
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/.dockerignore \
          /usr/share/nginx/html/nginx.conf.template \
          /usr/share/nginx/html/serve.sh

EXPOSE 8080
