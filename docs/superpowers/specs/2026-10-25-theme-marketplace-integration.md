# 主题市场（获取主题）接入约定

日期：2026-10-25  
状态：入口与弹窗已预留，市场地址暂时留空，未写入任何外部链接。  
范围：`apps/web` 主题设置页的「获取主题」入口；不涉及内容、页面编排与自定义 CSS。

## 1. 现状

- 主题设置页（`/admin/themes`）在「导入主题」右侧新增「获取主题」按钮。
- 点击后打开悬浮窗，说明接入后的流程与安全边界；当前不请求任何外部地址。
- 代码里预留常量：

  ```ts
  // apps/web/src/lib/themes.ts
  export const THEME_MARKETPLACE_URL = '';
  ```

  留空时弹窗只显示说明；填入地址后弹窗出现「打开主题市场」按钮（行为已实现）。

## 2. 目标流程

1. 用户点击「获取主题」→ 弹窗展示市场列表（缩略预览、名称、版式、深浅色）。
2. 选中主题 → 预览（可复用 `ThemePreview` 组件）；确认安装。
3. 前端下载主题 JSON → 复用 `parseThemeFile()` 校验 → 写入 `customization.themes` 并可选立即应用。
4. 安装结果写入网站日志（`noteActivity`）。

## 3. 计划接口

### 3.1 列表

```
GET /api/v1/themes/marketplace
```

响应：

```json
{
  "items": [
    {
      "id": "theme_night_editorial",
      "name": "夜航 · 编辑部",
      "note": "暖黑双栏，适合摄影与长文",
      "variant": "bento",
      "mode": "dark",
      "preview_url": "https://.../preview.png",
      "download_url": "https://.../theme.json",
      "version": "1.0.0"
    }
  ],
  "next_cursor": ""
}
```

### 3.2 下载主题

`download_url` 返回现有导出格式（见 `downloadThemeFile()`），即：

```json
{
  "id": "...",
  "name": "...",
  "note": "...",
  "variant": "classic | bento",
  "theme": { "preset": "...", "mode": "...", "background": "...", "ink": "...", "accent": "...", "heading_font": "...", "body_size": 17.5, "content_width": 720, "radius": 6 }
}
```

前端必须继续用 `parseThemeFile()` 校验，拒绝包含文章、页面、自定义 CSS 或额外字段的文件。

## 4. 接入步骤（最小改动）

1. 在 `lib/themes.ts` 给 `THEME_MARKETPLACE_URL` 填市场站点地址。
2. 新增 `fetchMarketplaceThemes()`（可放在 `lib/themes.ts`），请求 3.1 的接口。
3. 在 `Themes.tsx` 的「获取主题」弹窗内渲染列表；安装动作复用 `parseThemeFile()` + `customization.themes` 写入逻辑，并调用 `noteActivity`。
4. 若市场需要鉴权或签名，密钥/令牌只允许放在服务端代理，不应写进浏览器配置。

## 5. 非目标

- 在线主题编辑器或远程主题运行时代码；
- 主题内脚本、第三方字体下载、自定义 CSS；
- 主题评分、付费与账户体系（后续单独设计）。
