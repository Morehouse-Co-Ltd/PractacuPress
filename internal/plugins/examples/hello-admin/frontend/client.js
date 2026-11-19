/*
 * Hello Admin — 纯前端扩展参考实现。
 *
 * 这个文件是「经典脚本 + 工厂注册」，不是 ES module：
 *   1. 宿主先注入 /plugins/<id>/<version>/client.js；
 *   2. 脚本调用 window.__PP_PLUGIN_REGISTER__(id, version, factory)；
 *   3. 宿主用冻结的模块表把工厂实例化，再把 ctx 交给 activate()。
 *
 * 本示例只用 React（宿主 external 模块）与官方扩展 API：
 *   ctx.admin.registerPage(...)  → 在 /admin/ext/<path> 注册一个后台页面
 * 页面渲染完全由扩展负责，宿主管导航与路由。
 */
(function () {
  'use strict';

  window.__PP_PLUGIN_REGISTER__('com.example.hello-admin', '1.0.0', function (require, module) {
    var React = require('react');

    function ClockPage() {
      var state = React.useState(new Date());
      var now = state[0];
      var setNow = state[1];
      React.useEffect(function () {
        var timer = window.setInterval(function () {
          setNow(new Date());
        }, 1000);
        return function () {
          window.clearInterval(timer);
        };
      }, []);

      return React.createElement(
        'div',
        { className: 'panel', style: { maxWidth: 640 } },
        React.createElement(
          'div',
          { className: 'panel-head' },
          React.createElement(
            'div',
            null,
            React.createElement('h3', null, 'Hello Admin'),
            React.createElement('p', null, '这个页面由纯前端扩展注册，没有服务端代码。'),
          ),
        ),
        React.createElement(
          'div',
          { className: 'panel-body' },
          React.createElement(
            'p',
            { className: 'sysmon-card-value', style: { fontSize: 34 } },
            now.toLocaleTimeString(),
          ),
          React.createElement(
            'p',
            { className: 'tiny faint' },
            '扩展 id：com.example.hello-admin · 每分钟刷新一次页面即可看到来自 manifest 的版本。',
          ),
        ),
      );
    }

    module.exports = {
      activate: function activate(ctx) {
        ctx.admin.registerPage({
          id: 'hello-admin',
          path: 'hello-admin',
          label: 'Hello Admin',
          icon: 'info',
          group: 'extensions',
          order: 10,
          description: '纯前端扩展示例：注册一个后台页面。',
          render: function renderPage() {
            return React.createElement(ClockPage);
          },
        });
        ctx.log('hello-admin activated');
      },
    };
  });
})();
