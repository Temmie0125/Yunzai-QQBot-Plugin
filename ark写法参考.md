## ark基本用法

- 使用`segment.ark(template_id,data)`通用用法、`segment.ark23(data)`、`segment.ark24(data)`、`segment.ark37(data)`快捷用法可以自动构造ark模板消息，其中template_id为模板id（当前可选23、24、37），data为模板内容

- 前置条件:机器人需要为***私域bot***才可使用（是否有权限需自行尝试）

---

## 快速上手

```
// 通用入口
segment.ark(23, { desc: '...', prompt: '...', list: [...] })
segment.ark(24, { desc: '...', prompt: '...', title: '...', ... })
segment.ark(37, { prompt: '...', metaTitle: '...', ... })

// 快捷方法（推荐）
segment.ark23({ desc: '...', prompt: '...', list: [...] })
segment.ark24({ desc: '...', prompt: '...', title: '...', ... })
segment.ark37({ prompt: '...', metaTitle: '...', ... })
```

### 支持的模板

| template_id | 名称 |
| --- | --- |
| 23 | 	链接 + 文本列表 |
| 24 | 文本 + 缩略图 |
| 37 | 大图 |

---

## 通用规则

- 字段取值容错：字段名`大小写`、`下划线` / `驼峰差异`均可自动识别，以下写法等价

```
metaTitle === meta_title === METATITLE === metatitle
metaUrl   === meta_url   === METAURL
```

- 必填校验：除 list[].link 外所有字段均为必填，缺失或为空字符串时抛错

- 类型容错：数字会自动转字符串（prompt: 123 → "123"）；字符串会去除首尾空格

---

## 模板 23 — 链接 + 文本列表

### 字段

| 变量 | 参数名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `#DESC#` | `desc` | string | 是 | 描述 |
| `#PROMPT#` | `prompt` | string | 是 | 提示消息 |
| `#LIST#` | `list` | array | 是 | 文本列表，至少 1 项 |

`list` 元素字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `desc` | string | 是 | 文本内容 |
| `link` | string | 否 | 跳转链接，**需提前报备**；不填则仅显示文本 |

### `list` 的四种写法

```js
// ① 对象（推荐）
{ desc: '已评审', link: 'https://qun.qq.com' }

// ② 对象，仅文本
{ desc: '需求标题：UI问题解决' }

// ③ 数组简写 [desc, link]
['已排期', 'https://qun.qq.com']

// ④ 字符串简写
'请关注'
```

> `list` 可以不是数组，传单个元素会自动包成数组；支持一层嵌套数组自动扁平化。

### 调用示例

```js
segment.ark23({
  desc: '机器人订阅消息',
  prompt: 'XX机器人',
  list: [
    { desc: '需求标题：UI问题解决' },
    { desc: '当前状态"体验中"，点击下列动作直接扭转状态到：' },
    { desc: '已评审',   link: 'https://qun.qq.com' },
    { desc: '已排期',   link: 'https://qun.qq.com' },
    { desc: '开发中',   link: 'https://qun.qq.com' },
    { desc: '增量测试中', link: 'https://qun.qq.com' },
    { desc: '请关注' }
  ]
})
```

### 生成的 kv

```json
{
  "type": "ark",
  "ark": {
    "template_id": 23,
    "kv": [
      { "key": "#DESC#",   "value": "机器人订阅消息" },
      { "key": "#PROMPT#", "value": "XX机器人" },
      {
        "key": "#LIST#",
        "obj": [
          { "obj_kv": [{ "key": "desc", "value": "需求标题：UI问题解决" }] },
          { "obj_kv": [{ "key": "desc", "value": "已评审" },
                       { "key": "link", "value": "https://qun.qq.com" }] }
        ]
      }
    ]
  }
}
```

### 常见错误

```js
Error: [ark 23] list 不能为空
Error: [ark 23] list[2].desc 必填
Error: [ark 23] list[2].link 必须是 http(s) 链接
Error: [ark 23] list[1] 格式无效        // 元素既非字符串/数组/对象
```

---

## 模板 24 — 文本 + 缩略图

### 字段

| 变量 | 参数名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `#DESC#` | `desc` | string | 是 | 描述 |
| `#PROMPT#` | `prompt` | string | 是 | 提示文本 |
| `#TITLE#` | `title` | string | 是 | 标题 |
| `#METADESC#` | `metadesc` | string | 是 | 详情描述 |
| `#IMG#` | `img` | string | 是 | 图片链接 |
| `#LINK#` | `link` | string | 是 | 跳转链接 |
| `#SUBTITLE#` | `subtitle` | string | 是 | 来源 |

### 调用示例

```js
segment.ark24({
  desc: '描述文本',
  prompt: '通知信息',
  title: '标题',
  metadesc: 'Meta描述',
  img: 'https://pub.idqqimg.com/pc/misc/files/20190820/2f4e70ae3355ece23d161cf5334d4fc1jzjfmtep.png',
  link: 'https://qq.com',
  subtitle: '子标题'
})
```

### 常见错误

```js
Error: [ark 24] img 必须是 http(s) 链接
Error: [ark 24] subtitle 必填
```

---

## 模板 37 — 大图

### 字段

| 变量 | 参数名 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `#PROMPT#` | `prompt` | string | 是 | 提示消息 |
| `#METATITLE#` | `metatitle` | string | 是 | 标题 |
| `#METASUBTITLE#` | `metasubtitle` | string | 是 | 子标题 |
| `#METACOVER#` | `metacover` | string | 是 | 大图，**尺寸 975×540** |
| `#METAURL#` | `metaurl` | string | 是 | 跳转链接 |

### 调用示例

```js
segment.ark37({
  prompt: '通知提醒',
  metaTitle: '标题',
  metaSubtitle: '子标题',
  metaCover: 'https://vfiles.gtimg.cn/vupload/20211029/bf0ed01635493790634.jpg',
  metaUrl: 'https://qq.com'
})
```

> 封面图请严格按 **975×540** 出图，否则大图区域会被裁剪或拉伸。
