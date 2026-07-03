<div align="center">

# TRSS-Yunzai QQBot Plugin

TRSS-Yunzai QQBot 适配器 插件(自用修改版)

[🔗内部交流群 1095352740](https://qm.qq.com/q/JxYAlbKRGy)

</div>

## 安装教程

1. 准备：[TRSS-Yunzai](../../../Yunzai)
2. 在yunzai根目录使用
```
git clone https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin.git ./plugins/QQBot-Plugin
```
3. 打开：[QQ 开放平台](https://q.qq.com) 创建 Bot：  
① 创建机器人  
② 开发设置 → 得到 `机器人QQ号:AppID:Token:AppSecret`  
4. 输入：`#QQBot设置机器人QQ号:AppID:Token:AppSecret:[012]:[01]`

## 格式示例

- 机器人QQ号 `114` AppID `514` Token `1919` AppSecret `810` 群Bot 频道私域

```
#QQBot设置114:514:1919:810:1:1
```

- WebHook

```
#QQBot设置114:514:1919:810:2
```

需要启用公网 HTTPS，开放平台添加 url/QQBot

## 使用教程

- #QQBot账号
- #QQBot设置 + `机器人QQ号:AppID:Token:AppSecret:是否群Bot:是否频道私域`（是1 否0）
- #QQBotMD + `机器人QQ号:raw`（默认状态就会在QQ群和私信使用原生markdown，如果手动设置raw频道也会使用原生发送，但是频道需要原生MD权限）
- #QQBotMD + `机器人QQ号:legacy`（默认状态就会在QQ群和私信使用原生markdown，如果手动设置legacy群聊会使用普通消息发送）
- #QQBotMD + `机器人QQ号:模板id:模板参数内容`（需要申请MD模板，模板参数内容用,隔开）
- #rawButton + `机器人QQ号:true或false`（如果有原生按钮权限则设置true，如果没有则不用设置，默认为true使用原生按钮）
- `#开启bot消息过滤`/`#关闭bot消息过滤` 可以开关过滤，以免官机之间相互触发
- `#开启纯at其他bot过滤`/`#关闭纯at其他bot过滤` 可以开关只艾特了其他官机的消息的过滤，以免在使用其他机器人时触发

## 与原版区别

<details><summary>markdown处理默认处理方式改变</summary>

- QQ群与私信默认使用原生markdown发送，如果发送失败会先尝试再发送一遍，如果再次失败会根据是否设置了模板然后用模板或者普通消息再次发送一遍，如果还是失败则会使用普通消息发送最后一次。
- 频道与频道私信根据设置MD内容选择，如果设置的raw，频道会使用原生(有原生md权限才可以发送)，如果是模板id则使用模板，没有设置则会使用普通消息发送，如果失败了后续重试步骤如QQ群
- 单独控制每个号的模板，以免申请模板不同导致无法一起使用

</details>

<details><summary>新增原生按钮控制</summary>

- 根据设置自动判断是否使用按钮，若是无原生按钮权限，则自动将原本的按钮转换成对应的蓝字，写法与原生按钮完全相同
- 按钮写法参考[🔗按钮写法.md](https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin/blob/main/按钮写法.md)

</details>

<details><summary>新增分享链接获取</summary>

- 调用方式e.getGenerateUrl(callback_data),callback_data类型为string(32)，会在机器人新增好友时传入(⚠经测试仅wh能够收到这个callback_data，ws没有)，参考使用[🔗分享链接.js](https://gitee.com/wind-trace-typ/wind-js/blob/master/%E5%88%86%E4%BA%AB%E9%93%BE%E6%8E%A5.js)
- 如果需要接收新增好友事件并进行处理还需要修改qq-group-bot依赖(❗现改为@windtrace/qq-group-bot,无需手动修改)，改动参考[🔗依赖改动.md](https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin/blob/main/%E4%BE%9D%E8%B5%96%E6%94%B9%E5%8A%A8.md)

</details>

<details><summary>新增字段</summary>

- e.platform，私信/群聊/临时会话/频道私信/频道/频道临时会话分别为`QQ-private`、`QQ-group`、`QQ-group-member`、`guild-private`、`guild-channel`、`guild-channel-member`
- 新增e.nickname与e.avatar,现官机已开放用户昵称获取，此外原版插件头像链接获取麻烦我直接加上e.avatar
- e.reply_user，用户引用对象信息，含有以下属性`{bot:boolean {true|false}`是否bot,`username:string}`引用用户昵称
- e.mentions,用户艾特的对象信息，`[object,object]`,每个对象含有以下几种属性`bot:boolean`是否bot，`id:string`、`member_openid:string`用户openid、`scope:string {'single'|'all'}`一般艾特单个用户为single，艾特全体为all，`username:string`用户昵称
- e.at,艾特的对象的openid，一般取最后一个非bot用户的openid，如果全是bot则取最后一个bot的openid
- e.message中，根据payload中得到的mentions填入艾特对象，`type:string`这里为at，`user_id:string`艾特对象的openid，`username:string`艾特对象昵称，`bot:boolean {true|false}`是否bot，`qq:string`本适配器的用户id即e.self_id+':'+e.openid

</details>

<details><summary>链接处理更改</summary>

- 不再将链接转换成二维码，目前`直接发送`或`<链接>`的方式发送可以无白名单检测可以随便发送，`[🔗](链接)`的方式发送可以发送域名为qun.qq.com的链接

</details>

user_id仅用:分割，以免数据迁移有问题

<details><summary>新增文件发送功能(当前仅私聊可发送)</summary>

- 使用方法this.reply(segment.file(file,filename))，此功能需额外修改qq-group-bot依赖(❗现改为@windtrace/qq-group-bot,无需手动修改)，修改参考[🔗依赖改动.md](https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin/blob/main/%E4%BE%9D%E8%B5%96%E6%94%B9%E5%8A%A8.md)

</details>

<details><summary>回调按钮改变发送及信息获取方式</summary>

- 原版是根据msg_id在内存中获取发送的按钮的回调内容群号，用户id，msg_id等信息，现在直接传输data，直接从回调中获取数据，原版在重启或300s后按钮就失效了，现在只要按钮还在没有过期就可以使用，发送回调按钮方法this.reply(segment.button([{text:'showtext',callback:'inputtext',toCallback:true}])),仅当有原生按钮权限才可使用

</details>

<details><summary>允许插件处理事件</summary>

- 例如机器人加入群聊、新增用户，群员增加或减少等，都可自定义回复，参考示例[🔗官机入群发言.js](https://gitee.com/wind-trace-typ/wind-js/blob/master/%E5%AE%98%E6%9C%BA%E5%85%A5%E7%BE%A4%E5%8F%91%E8%A8%80.js)
- 如果机器人被移除报错那是因为plugins/example/进群退群通知.js接收到了官机的退群事件，那么可以修改这里(当然不修改也可以，不影响使用),若是其他插件也有接收进官机退群等事件并响应的可以在对应事件处理位置添加以下判断`if(e.adapter_id==='QQBot') return`

```
async accept() {
    if (this.e.user_id == this.e.self_id || this.e.adapter_id === 'QQBot') return
    /*
        后续处理不变
    */
  }
```

</details>

<details><summary>新增支持引用以及解析用户引用消息</summary>

- 如果需要引用用户消息（当前仅私信可以艾特，且尽量在使用普通消息才引用，目前markdown使用引用后会有bug），可使用`segment.reply(e.msg_idx)`,如果需要引用用户引用的消息可使用`segment.reply(e.ref_msg_idx)`，用户引用的消息内容为e.msg_elements,当前可解析到用户引用的`文字`，`face表情`，`图片`，`语音`，`视频`，`文件`，官机的艾特等详细信息(参考[🔗msg_elements.md](https://gitee.com/wind-trace-typ/Yunzai-QQBot-Plugin/blob/main/msg_elements.md))，当前还无法解析到卡片，ark，转发消息，普通用户艾特等详细信息，如果不想使用segment.reply想直接使用`this.reply(msg,quote)`，可修改`Yunzai/lib/plugins/loader.js`的435-440行的

```
      if (quote && e.message_id) {
        if (Array.isArray(msg)) msg.unshift(segment.reply(e.message_id))
        else msg = [segment.reply(e.message_id), msg]
      }
        ⬇ ⬇ ⬇ （把上面部分的代码修改成下面的代码）
      if (quote) {
        let reply_id
        if (e.adapter_id === 'QQBot' && e.msg_idx) {
          reply_id = e.msg_idx
        } else if (e.message_id) {
          reply_id = e.message_id
        }
        
        if (reply_id) {
          if (Array.isArray(msg)) {
            msg.unshift(segment.reply(reply_id))
          } else {
            msg = [segment.reply(reply_id), msg]
          }
        }
      }
```

</details>

<details><summary>新增C2C流式信息</summary>

- 可在`config/QQBot.yaml`中将`steam`值改成`true`全局开启（发送失败或无法使用流式的消息会自动回退正常发送），也可不全局开启，在需要使用的地方加上`segment.custom('stream')`或`segment.custom('stream',{chunkSize,delay})`这里chunkSize为每次显示的字符数，delay为每次显示的延迟(ms)，如果不填则使用`config/QQBot.yaml`中的默认值，或者在`Yunzai/lib/plugins/loader.js`的435-440行下面添加

```
    if (data.stream) {
        e.stream = true
        e.chunkSize = data.chunkSize || ''
        e.delay = data.delay || ''
      }
```

然后就可以使用`this.reply(msg,quote,{stream,chunkSize,delay})`发送流式消息
</details>

<details><summary>支持自定义图床</summary>

- 可自行在example目录中加入js定义Bot.imageToUrl图片上传函数，返回上传得到的图片url，本插件会如果检测到该函数存在就会优先使用，可直接使用或参考我的[cnb图床.js](https://gitee.com/wind-trace-typ/cnb-image-bed)

</details>

<details><summary>支持自定义markdown模板处理</summary>

- 可自行在example目录中加入js定义Bot.makeMarkdownMsg图片上传函数，返回上传得到的图片url，本插件会如果检测到该函数存在就会优先使用,例:

```
Bot.makeMarkdownMsg = async (data, msg) => {
    //自定义的处理逻辑
    return messages //返回处理好的消息
}
```

</details>

<details><summary>新增C2C输入状态修改</summary>

- 默认有消息传入时会有30s正在输入的显示，一旦用户再次发送或者机器人发送了消息，这个状态会自动打断，如果想主动使用正在输入的状态，可使用`e.sendInputNotify(seconds)`,seconds为显示状态改变的时间，可以不填使用`e.sendInputNotify()`，这样默认改变30s

</details>

<details><summary>修复使用event_id发送文件</summary>

- 原版处理文件时在没有msg_id时直接将`srv_send_msg`设置成`true`，而这样会占用`主动消息频次`，现在除开频道和私信沙箱无主动消息所以会导致如进群、新增好友、回调按钮等事件本可以使用`event_id`回复但这里发送文件、语音、视频、图片会提示参数错误，现已修复，只要有`msg_id`或`event_id`就会先上传再发送`file_info`

</details>

</details>

<details><summary>ws官机支持扫码登录</summary>

- 可以直接发送`#QQBot扫码登录`生成二维码和登录链接，扫码或者点击链接并选择合适的bot登录即可，注意❗❗❗：此登录方法会成功会重置旧的secret，请确定是否需要使用此功能登录，否则请使用`#QQBot设置`登录Bot

- 若启动时无任何bot，则自动获取登录二维码和链接显示在日志中，方便首次登录

</details>

<details><summary>主动获取群成员信息(悲报此接口权限仅开放了一天半就被拿下了，暂时无使用权限)</summary>

- 在插件中，可以通过以下几种方式获取指定用户信息

```
  await e.member.getGroupMemberInfo() //直接获取当前用户的群成员信息
  await e.group.pickMember(user_id).getGroupMemberInfo() //获取当前群指定用户信息
  await e.bot.pickGroup(group_id).pickMember(user_id).getGroupMemberInfo() //获取指定群指定用户信息
  如果需要获取自己bot信息，可以使用
  await e.group.pickMember(e.bot_opneid).getGroupMemberInfo() //获取当前bot信息e.bot_openid为当前bot的openid当在全量群艾特机器人后会自动记录，请在使用前自行确保e.bot_openid存在
  或使用await e.getBotInfo()获取bot信息,仍然需要在记录bot的openid后使用
```

- 本接口返回信息是已经经过处理过的，并非官方返回的原始结构，大致结构如下：

```
{
  "openid": "用户openid",
  "unionid": "用户unionid",
  "avatar": "用户头像",
  "card": "用户昵称",
  "nickname": "用户昵称",
  "join_time": 入群时间戳,
  "role": "当前用户在群中身份，owner/admin/member对应群主/管理员/群员",
  "bot": 是否bot
}
```

</details>

## 问题反馈

- [🔗内部交流群 1095352740](https://qm.qq.com/q/JxYAlbKRGy)反馈
- 邮箱459521475@qq.com反馈
- 直接提issue反馈(可能不会及时看到)
