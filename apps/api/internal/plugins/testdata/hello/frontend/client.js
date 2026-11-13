/*
 * Reference browser bundle for the Practacu Press plugin host.
 *
 * The bundle is a classic script, not an ES module. It only registers a factory;
 * the host materialises the factory later with its frozen module table. That is
 * what keeps React, ReactDOM and React Router single-instance without eval() and
 * without import maps. A real plugin would generate this wrapper with its build
 * tooling (esbuild --format=cjs + a tiny registration footer).
 */
(function () {
  'use strict';
  window.__PP_PLUGIN_REGISTER__('com.example.hello', '1.0.0', function (require, module, exports) {
    var React = require('react');

    function HelloCard(props) {
      var name = props.block && props.block.props && props.block.props.name;
      return React.createElement(
        'div',
        { className: 'pp-hello-card', 'data-pp-plugin': 'com.example.hello' },
        React.createElement('strong', null, 'Hello ' + (name || 'world')),
        React.createElement('p', null, 'Rendered by a runtime plugin block.')
      );
    }

    function ArticleFooter() {
      return React.createElement(
        'aside',
        { className: 'pp-hello-footer', 'data-pp-plugin': 'com.example.hello' },
        'Hello PP is installed. ',
        React.createElement('a', { href: '/api/v1/plugins/com.example.hello/hello' }, 'Plugin route')
      );
    }

    module.exports = {
      activate: function activate(ctx) {
        ctx.slots.register('article.after', 'footer', ArticleFooter);
        ctx.blocks.register('hello.card', HelloCard);
        ctx.ui.addStyle(
          '.pp-hello-card{border:1px solid var(--pp-accent,#1f5c4a);border-radius:8px;padding:12px}' +
            '.pp-hello-footer{font-size:13px;opacity:.8}'
        );
      },
    };
  });
})();
