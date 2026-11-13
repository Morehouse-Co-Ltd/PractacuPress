'use strict';

/**
 * Practacu Press API reference.
 *
 * The page is deliberately dependency free: it is embedded in the Go binary, so it
 * must work offline and behind a strict Content-Security-Policy that forbids inline
 * script and third party origins. The only input is the contract served by the same
 * instance at /api/v1/openapi.json.
 */
const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const state = {
  spec: null,
  operations: [],
  tag: 'all',
  query: '',
};

document.addEventListener('DOMContentLoaded', () => {
  const search = document.getElementById('operation-search');
  if (search) {
    search.addEventListener('input', (event) => {
      state.query = event.target.value.trim().toLowerCase();
      renderOperations();
    });
  }
  init().catch((error) => showFatal(error));
});

async function init() {
  const response = await fetch(new URL('openapi.json', document.baseURI), {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(problemMessage(body) || `The contract request failed with HTTP ${response.status}.`);
  }
  if (!body || !body.openapi || !body.paths) {
    throw new Error('The response is not an OpenAPI document.');
  }

  state.spec = body;
  state.operations = collectOperations(body);

  const meta = document.getElementById('spec-meta');
  if (meta) {
    const title = body.info?.title || 'Practacu Press API';
    const version = body.info?.version || '';
    meta.textContent = `${title}${version ? ` ${version}` : ''} · ${state.operations.length} operations`;
  }

  renderIntro();
  renderTagNav();
  renderOperations();
}

function showFatal(error) {
  const intro = document.getElementById('intro');
  if (intro) {
    intro.classList.add('error');
    intro.replaceChildren(
      h('h1', {}, 'The contract could not be loaded'),
      h('p', {}, error?.message || String(error)),
      h('p', { class: 'muted' }, 'The raw document is still available at '),
    );
    intro.append(h('p', {}, h('a', { href: 'openapi.json' }, 'openapi.json')));
  }
  const meta = document.getElementById('spec-meta');
  if (meta) meta.textContent = 'Contract unavailable';
}

/* ------------------------------ data ------------------------------ */

function collectOperations(spec) {
  const paths = spec.paths || {};
  const operations = [];

  for (const path of Object.keys(paths).sort()) {
    const item = paths[path] || {};
    const pathParameters = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of METHOD_ORDER) {
      const operation = item[method];
      if (!operation) continue;

      const tags = Array.isArray(operation.tags) && operation.tags.length
        ? [...operation.tags]
        : ['untagged'];

      operations.push({
        path,
        method,
        item,
        op: operation,
        tags,
        parameters: mergeParameters(pathParameters, operation.parameters),
        summary: operation.summary || item.summary || '',
      });
    }
  }

  return operations;
}

function mergeParameters(pathLevel, operationLevel) {
  const merged = new Map();

  for (const parameter of [...(pathLevel || []), ...(operationLevel || [])]) {
    const resolved = resolveRef(parameter) || parameter;
    if (!resolved || !resolved.name) continue;
    merged.set(`${resolved.in}:${resolved.name}`, resolved);
  }

  return [...merged.values()];
}

function resolveRef(value) {
  let current = value;
  const seen = new Set();

  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return current;
    seen.add(current.$ref);
    current = lookupJsonPointer(current.$ref);
    if (current === undefined) return value;
  }
  return current;
}

function lookupJsonPointer(ref) {
  if (!state.spec || !ref.startsWith('#/')) return undefined;
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'));

  let current = state.spec;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function refName(ref) {
  return String(ref)
    .split('/')
    .pop()
    .replace(/~1/g, '/')
    .replace(/~0/g, '~');
}

/* ------------------------------ rendering ------------------------------ */

function renderIntro() {
  const intro = document.getElementById('intro');
  if (!intro) return;

  const info = state.spec.info || {};
  const servers = Array.isArray(state.spec.servers) ? state.spec.servers : [];
  const schemes = Object.entries(state.spec.components?.securitySchemes || {});
  const tagCount = new Set(state.operations.flatMap((operation) => operation.tags)).size;

  const children = [
    h('h1', {}, info.title || 'Practacu Press API', ' ', h('span', { class: 'version' }, info.version || '1.0.0')),
  ];

  if (info.description) {
    children.push(h('p', { class: 'intro-description' }, richText(info.description)));
  }

  children.push(
    h('div', { class: 'stats' },
      stat(String(Object.keys(state.spec.paths || {}).length), 'paths'),
      stat(String(state.operations.length), 'operations'),
      stat(String(tagCount), 'tags'),
      stat(String(schemes.length), 'auth schemes'),
    ),
  );

  const serverList = h('ul', {});
  if (servers.length === 0) {
    serverList.append(h('li', {}, h('span', { class: 'muted' }, 'Same origin, /api/v1')));
  } else {
    for (const server of servers) {
      serverList.append(h('li', {},
        h('code', {}, server.url || '/'),
        server.description ? h('span', { class: 'muted' }, ` — ${server.description}`) : null,
      ));
    }
  }

  const authList = h('ul', {});
  if (schemes.length === 0) {
    authList.append(h('li', {}, h('span', { class: 'muted' }, 'No security scheme declared')));
  } else {
    for (const [name, scheme] of schemes) {
      const details = [scheme?.type, scheme?.scheme, scheme?.bearerFormat].filter(Boolean).join(' · ');
      authList.append(h('li', {}, h('code', {}, name), details ? h('span', { class: 'muted' }, ` — ${details}`) : null));
    }
  }

  children.push(h('div', { class: 'intro-grid' },
    h('section', {}, h('h2', {}, 'Servers'), serverList),
    h('section', {}, h('h2', {}, 'Authentication'), authList),
  ));

  intro.replaceChildren(...children);
}

function renderTagNav() {
  const nav = document.getElementById('tag-nav');
  if (!nav) return;

  const counts = new Map();
  for (const operation of state.operations) {
    for (const tag of operation.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  const declared = (state.spec.tags || []).map((tag) => tag.name).filter(Boolean);
  const ordered = [];
  for (const tag of declared) if (!ordered.includes(tag)) ordered.push(tag);
  for (const tag of counts.keys()) if (!ordered.includes(tag)) ordered.push(tag);

  const options = [['all', state.operations.length], ...ordered.map((tag) => [tag, counts.get(tag) || 0])];

  nav.replaceChildren();
  for (const [tag, count] of options) {
    const label = tag === 'all' ? 'All operations' : tag;
    const button = h('button',
      { type: 'button', 'aria-current': state.tag === tag ? 'true' : 'false' },
      h('span', {}, label),
      h('span', { class: 'count' }, String(count)),
    );
    button.addEventListener('click', () => {
      state.tag = tag;
      renderTagNav();
      renderOperations();
    });
    nav.append(button);
  }
}

function renderOperations() {
  const container = document.getElementById('operations');
  if (!container) return;

  const visible = state.operations.filter(matchesFilter);
  container.replaceChildren();

  if (visible.length === 0) {
    container.append(h('section', { class: 'panel empty' },
      h('p', {}, 'No operation matches the current filter.'),
    ));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const operation of visible) fragment.append(renderOperation(operation));
  container.append(fragment);
}

function matchesFilter(operation) {
  if (state.tag !== 'all' && !operation.tags.includes(state.tag)) return false;
  if (!state.query) return true;

  const haystack = [
    operation.method,
    operation.path,
    operation.summary,
    operation.op.description,
    ...operation.tags,
  ].filter(Boolean).join(' ').toLowerCase();

  return haystack.includes(state.query);
}

function renderOperation(operation) {
  const anchor = `op-${operation.method}-${operation.path}`
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const root = h('section', { class: 'op', id: anchor });
  const head = h('div', { class: 'op-head' },
    h('span', { class: `method ${methodClass(operation.method)}` }, operation.method.toUpperCase()),
    h('span', { class: 'op-path' }, operation.path),
  );

  if (operation.op.deprecated) head.append(h('span', { class: 'chip danger' }, 'Deprecated'));
  root.append(head);

  const body = h('div', { class: 'op-body' });

  if (operation.summary) {
    body.append(h('p', { class: 'op-summary' }, operation.summary));
  }

  const meta = h('div', { class: 'op-meta' });
  for (const tag of operation.tags) meta.append(h('span', { class: 'chip' }, tag));
  for (const label of securityLabels(operation.op)) meta.append(h('span', { class: 'chip warn' }, label));
  body.append(meta);

  if (operation.op.description) {
    body.append(h('p', { class: 'op-description' }, richText(operation.op.description)));
  }

  appendParameters(body, operation.parameters);
  appendRequestBody(body, operation.op.requestBody);
  appendResponses(body, operation.op.responses);

  root.append(body);
  return root;
}

function appendParameters(container, parameters) {
  if (!parameters || parameters.length === 0) return;

  container.append(h('div', { class: 'section-title' }, 'Parameters'));

  const rows = parameters.map((parameter) => h('tr', {},
    h('td', {}, h('code', {}, parameter.name)),
    h('td', {}, h('span', { class: 'chip' }, parameter.in || 'query')),
    h('td', {}, parameter.required ? h('span', { class: 'chip warn' }, 'required') : h('span', { class: 'muted' }, 'optional')),
    h('td', {}, schemaLabel(parameter.schema)),
    h('td', { class: 'desc' },
      parameter.description ? h('p', {}, parameter.description) : null,
      schemaDetails(parameter.schema),
    ),
  ));

  container.append(h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, 'Name'), h('th', {}, 'In'), h('th', {}, 'Required'), h('th', {}, 'Type'), h('th', {}, 'Description'),
      )),
      h('tbody', {}, ...rows),
    ),
  ));
}

function appendRequestBody(container, requestBody) {
  if (!requestBody) return;
  const body = resolveRef(requestBody) || requestBody;

  container.append(h('div', { class: 'section-title' }, 'Request body'));

  const section = h('div', { class: 'media' });
  const head = h('div', { class: 'media-head' }, h('strong', {}, 'Body'));
  if (body.required) head.append(h('span', { class: 'chip warn' }, 'required'));
  section.append(head);

  if (body.description) section.append(h('p', { class: 'desc' }, body.description));
  appendMedia(section, body.content);

  container.append(section);
}

function appendResponses(container, responses) {
  if (!responses) return;

  container.append(h('div', { class: 'section-title' }, 'Responses'));

  const entries = Object.entries(responses).sort(([left], [right]) => {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    if (Number.isFinite(a)) return -1;
    if (Number.isFinite(b)) return 1;
    return left.localeCompare(right);
  });

  const list = h('div', {});
  for (const [status, raw] of entries) {
    const response = resolveRef(raw) || raw;
    const description = h('div', { class: 'response-desc' },
      h('p', {}, richText(response.description || '')),
    );
    appendMedia(description, response.content, true);

    list.append(h('div', { class: 'response' },
      h('span', { class: `status ${statusClass(status)}` }, status),
      description,
    ));
  }

  container.append(list);
}

function appendMedia(container, content, nested = false) {
  if (!content || typeof content !== 'object') return;

  for (const [mediaType, media] of Object.entries(content)) {
    const resolved = resolveRef(media) || media || {};
    const box = h('div', { class: nested ? 'media' : '' });
    box.append(h('div', { class: 'media-head' },
      h('code', {}, mediaType),
      h('span', { class: 'chip' }, schemaLabel(resolved.schema)),
    ));

    if (resolved.example !== undefined) {
      box.append(h('details', {},
        h('summary', {}, 'Example'),
        h('pre', {}, pretty(resolved.example)),
      ));
    }

    if (resolved.examples && typeof resolved.examples === 'object') {
      for (const [name, example] of Object.entries(resolved.examples)) {
        const value = resolveRef(example) || example;
        box.append(h('details', {},
          h('summary', {}, `Example: ${name}`),
          h('pre', {}, pretty(value?.value !== undefined ? value.value : value)),
        ));
      }
    }

    const details = schemaDetails(resolved.schema);
    if (details) box.append(details);
    container.append(box);
  }
}

function schemaDetails(schema) {
  if (!schema || typeof schema !== 'object') return null;
  return h('details', {},
    h('summary', {}, 'Schema'),
    h('pre', {}, pretty(schema)),
  );
}

function schemaLabel(schema, depth = 0) {
  if (schema == null) return 'any';
  if (typeof schema !== 'object') return String(schema);
  if (schema.$ref) return refName(schema.$ref);
  if (depth > 5) return '…';

  if (schema.type === 'array') return `array<${schemaLabel(schema.items, depth + 1)}>`;
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.map((value) => JSON.stringify(value)).join(' | ')})`;
  if (schema.oneOf) return schema.oneOf.map((value) => schemaLabel(value, depth + 1)).join(' | ');
  if (schema.anyOf) return schema.anyOf.map((value) => schemaLabel(value, depth + 1)).join(' | ');
  if (schema.allOf) return schema.allOf.map((value) => schemaLabel(value, depth + 1)).join(' & ');
  if (schema.type) {
    return schema.format ? `${schema.type} (${schema.format})` : schema.type;
  }
  if (schema.properties) return 'object';
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  return 'any';
}

function securityLabels(operation) {
  const security = operation.security !== undefined ? operation.security : state.spec.security;

  if (!Array.isArray(security) || security.length === 0) return ['Public'];

  const schemes = state.spec.components?.securitySchemes || {};
  return security.map((requirement) => {
    const names = Object.keys(requirement || {});
    if (names.length === 0) return 'Public';
    return names.map((name) => {
      const scopes = Array.isArray(requirement[name]) ? requirement[name] : [];
      const scheme = schemes[name] || {};
      const label = scheme.type === 'http' && scheme.scheme ? `${name} (${scheme.scheme})` : name;
      return scopes.length ? `${label}: ${scopes.join(', ')}` : label;
    }).join(' + ');
  });
}

function methodClass(method) {
  switch (method) {
    case 'get': return 'method-get';
    case 'post': return 'method-post';
    case 'put':
    case 'patch': return 'method-put';
    case 'delete': return 'method-delete';
    default: return 'method-other';
  }
}

function statusClass(status) {
  if (/^2/.test(status)) return 'status-2xx';
  if (/^4/.test(status)) return 'status-4xx';
  if (/^5/.test(status)) return 'status-5xx';
  return 'status-other';
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
}

function problemMessage(body) {
  if (!body || typeof body !== 'object') return '';
  return body.message || body.title || body.detail || '';
}

/**
 * richText renders the `code` spans the contract uses in prose. Everything else stays
 * text, so a description can never inject markup.
 */
function richText(value) {
  const fragment = document.createDocumentFragment();
  String(value).split('`').forEach((part, index) => {
    if (!part) return;
    if (index % 2 === 1) fragment.append(h('code', {}, part));
    else fragment.append(document.createTextNode(part));
  });
  return fragment;
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * h builds one element without innerHTML, so contract text can never become markup.
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}
