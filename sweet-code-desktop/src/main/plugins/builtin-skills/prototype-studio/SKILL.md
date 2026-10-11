---
name: prototype-studio
description: 在「原型工坊」里做或改 App / 网页的可点击原型（prototypes/ 文件夹）。用户说做原型、画页面、出设计稿、做个 App 界面看看效果时使用。
---

# 原型工坊的文件格式

原型保存在项目的 `prototypes/<原型名>/` 里，用户在左侧「原型工坊」里看到画布，每个页面实时渲染，点「演示」能像真 App 一样点来点去。

```
prototypes/<原型名>/
  canvas.json        页面列表和它们在画布上的位置
  tokens.css         设计令牌（CSS 变量），所有页面共用
  screens/*.html     每个页面一个完整的 HTML 文件
```

## canvas.json

```json
{
  "version": 1,
  "start": "login",
  "screens": [
    { "id": "login", "title": "登录", "file": "screens/login.html", "device": "phone", "width": 390, "height": 844, "x": 0, "y": 0 },
    { "id": "home", "title": "首页", "file": "screens/home.html", "device": "phone", "width": 390, "height": 844, "x": 510, "y": 0 }
  ]
}
```

- `device`: `phone`（390×844）、`tablet`（820×1180）、`desktop`（1440×900）。
- 页面横着排，每个之间留 120 的间距（x 依次加 宽度 + 120）。
- `id` 用简短的英文小写，比如 `login`、`task-detail`。

## 页面怎么写

- 每个页面是完整的 HTML：`<!doctype html>`、`<meta charset="utf-8">`、`<link rel="stylesheet" href="../tokens.css">`，样式写在页面的 `<style>` 里。
- **跳转**：给可以点的元素加 `data-goto="<页面 id>"`，演示时点它就跳到那个页面，画布上也会画出连线。
- 颜色、圆角、字号都用 tokens.css 里的变量（`var(--color-primary)` 等），不要在页面里写死颜色；需要新颜色就先加到 tokens.css。
- 原型**不能联网**：不要引用 CDN、网络字体或网络图片。图标用内联 SVG，图片用 CSS 渐变或 `prototypes/<原型名>/assets/` 里的本地文件。
- 用真实的文案，不要写 lorem ipsum。按钮、输入框用真的 `<button>`、`<input>`。
- 页面高度按设备尺寸设计（手机 844），内容多可以超出，演示时能滚动。

## 做一个新原型的步骤

1. 先定风格：在 tokens.css 里写好配色、字体、圆角。
2. 写每个页面的 HTML，用 `data-goto` 把页面连起来。
3. 写 canvas.json，`start` 设成第一个页面。
4. 告诉用户：打开左侧的「原型工坊」就能看到，点「演示」可以试着点一点。
