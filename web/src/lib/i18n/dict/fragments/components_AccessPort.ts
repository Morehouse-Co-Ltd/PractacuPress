import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/AccessPort.tsx` */
const fragment: Dictionary = {
  '端口需要是 1–65535 之间的整数。': 'The port must be a whole number between 1 and 65535.',
  '端口已切换': 'Port switched',
  '正在跳转到 {origin}': 'Redirecting to {origin}',
  '端口切换失败，请稍后再试。': 'Could not switch the port. Please try again later.',
  访问端口: 'Access port',
  '站点对外提供访问的端口，默认 80。': 'The port this site is served on. Defaults to 80.',
  读取中: 'Reading',
  静态服务: 'Static server',
  开发服务器: 'Dev server',
  '正在读取运行时信息…': 'Reading runtime information…',
  当前地址: 'Current address',
  监听端口: 'Listening port',
  默认: 'Default',
  修改端口: 'Change port',
  '1–65535。应用后立即在新端口监听，本页会自动跳转。':
    '1–65535. The new port starts listening right away, and this page redirects automatically.',
  应用: 'Apply',
  '80 是浏览器默认端口，地址栏不用写端口号；改成其他端口后地址会带上':
    '80 is the browser default, so the address bar needs no port number; with any other port the address will carry',
  端口: 'port',
  '。切换时本站的配置与演示数据会一起带到新地址。':
    '. When you switch, this site’s settings and demo data are carried over to the new address.',
  端口在启动时确定: 'The port is fixed at startup',
  '当前由开发服务器（Vite）提供页面，运行中不能改端口。用':
    'Pages are currently served by the development server (Vite), which cannot change its port while running. A site started with',
  '运行的站点可以在后台直接修改。': 'can change its port from the admin.',
  命令已复制: 'Command copied',
  '在 web 目录下执行。': 'Run it inside the web directory.',
  复制命令: 'Copy command',
  '当前地址 {origin} · 端口 {port}': 'Current address {origin} · port {port}',
};

export default fragment;
