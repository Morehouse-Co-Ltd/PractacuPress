# Shared upstream settings for every request forwarded to the Go API.
#
# The file is included inside location blocks (never from conf.d directly), so it
# holds only proxy_* directives and the upstream target.
#
# `practacu_api` is declared with the `resolve` parameter in nginx.conf, so the
# name is re-resolved through Docker's embedded DNS. A static proxy_pass would
# cache the container IP once at startup and keep answering 502 after the API
# container is recreated with a new address.

proxy_pass http://practacu_api;
proxy_http_version 1.1;

# Keep the browser-facing host (including a mapped port) so absolute links and
# host-based site resolution see what the visitor typed. $pp_host is $http_host
# with a fallback for HTTP/1.0 clients that send no Host header.
proxy_set_header Host              $pp_host;
proxy_set_header X-Real-IP         $remote_addr;
# Append rather than overwrite: an outer TLS proxy already put the real client
# address in X-Forwarded-For, and the API walks the list from the right while
# skipping trusted peers, so a client-supplied value at the front is ignored.
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $pp_proto;
proxy_set_header X-Forwarded-Host  $pp_forwarded_host;

# WebSocket upgrade for /api/v1/ws. For ordinary requests the map expands to an
# empty value, which keeps the upstream connection reusable (a literal "close"
# would disable keep-alive to the API for every request).
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;

proxy_connect_timeout 5s;
