以下是我测试到的e.msg_elements,可进行参考

1.纯文字
```
msg_elements: [
    {
      content: '你好',
      msg_idx: 'REFIDX_s4q1wcl06VExNH0puO9kMstG81ovPjw88HwjHppK6Gc='
    }
  ]
```
2.表情
```
msg_elements: [
    {
      content: '<faceType=3,faceId="359",ext="eyJ0ZXh0Ijoi5YyF5Ymq6ZSkIn0=">',
      msg_idx: 'REFIDX_yDYfwE+CxBS6kY59eheLc8tG81ovPjw88HwjHppK6Gc='
    }
  ]
```
3.图片表情包
```
msg_elements: [
    {
      attachments: [
        {
          content: '',
          content_type: 'image/jpeg',
          filename: 'AEB85001164A764093C1CE86D76DA56C.jpg',
          height: 1178,
          size: 122219,
          url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhRPLxIPNLLQkmiATgApYNPKO2XDEBjrugcg_wooqvLtuIbPkwMyBHByb2RQgL2jAVoQditoFxHtQFjIif8lSWdVSnoCLrOCAQJuag&rkey=CAQSMAf0KkY0x6Ldyw0W9hILvs1aWq_8o_m0Vzue_pFVs_RXRfQLQQ6kmCsaSQTY9pVzQg&spec=0',
          width: 1242
        }
      ],
      content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      msg_idx: 'REFIDX_s/P2n1dmn6voWztdyiqt38tG81ovPjw88HwjHppK6Gc='
    }
  ]
```
4.语音
```
msg_elements: [
    {
      attachments: [
        {
          asr_refer_text: '黑黑的满把地吹，地下的老大枯萎，满巴飞，满飞我则看爱。See黑黑的曼巴的吹，地下的老大枯萎，满巴飞，满飞我折看爱心。',
          content_type: 'voice',
          filename: '3cabd28704bc2b62572e5f6ff2e61113.amr',
          size: 71895,
          url: 'https://multimedia.nt.qq.com.cn/download?appid=1403&fileid=EhSL46u38Hj5cJ2MWxlFCjyO4K44_RjXsQQg-wool6uK7IbPkwMyBHByb2RQgPUkWhC3DrdkQpoj_rE9KG5y6S33egJ7joIBAm5q&rkey=CAISqAGkgXpI1RtXzFmLrHJRqwR9FX-wWj9rFyNwMMRHdg2GvsZvxfTSZ_MpkKet_y2eJmD0cT2ici5vyTfGhalyEjEQkr7himkQRxg_G3rmsNQeWxbun1MgYTO3edysaEGPHDLU0wXCBsQAWyXKbP7VH47psKbYYieQ5VrJ2mjg2PC3m3j51oRpqgPc8JDdZ4tB-fq1WG1FveJ7M1DU5NqQBfU0mC5zvqiDuzM',
          voice_wav_url: 'https://qqbot.ugcimg.cn/uservoice/20260402192337_a7c71970c4d3488fbaff72edc7f4f969.wav'
        }
      ],
      content: '',
      msg_idx: 'REFIDX_2Blg5i5AF/lTlpeeVqv2E8tG81ovPjw88HwjHppK6Gc='
    }
  ]
```
5.视频
```
msg_elements: [
    {
      attachments: [
        {
          content_type: 'video/mp4',
          filename: 'e7aec1a0bf9243ade5c770e1e422eb6c.mp4',
          height: 1600,
          size: 132902,
          url: 'https://multimedia.nt.qq.com.cn/download?appid=1415&format=origin&orgfmt=t264&spec=0&rkey=CAQSoAHT0FpTC1mdm2gEJvEsGmwtHLSVvByYvLPtm7tx-e3WOsKmmnTfu54RyZAWgXjg6J7rtaOVzFU8-LDnriYFgZFE1MCDjFjCQpKJ3ZyqLWPCpUBMnMZ0nMWZqUa1SFoREtxTzFuxnmG-9pyz_LHfyR6dW-RuFWAX_MwPT3SIWe6JWr8Dfp1caHglbFDfDUJrVjHK2jNgLaRZJ_BUFcPJusQE',
          width: 720
        }
      ],
      content: '',
      msg_idx: 'REFIDX_KYop8b8wGpZLlJ4Xglms98tG81ovPjw88HwjHppK6Gc='
    }
  ]
```
6.文件
```
msg_elements: [
    {
      attachments: [
        {
          content_type: 'file',
          filename: '200mb_file.txt',
          size: 209715200,
          url: 'https://cqc-download.ftn.qq.com/ftn_handler/9b0351d09d991050970524e6b0ebac85a6ca5ca8dbbad0d6929cd222ca9c477d156e98dd4759c78f5d547725d5dc6d43156d338a5c5f2f8ddd34d5c899c2c495?fname=200mb_file.txt'
        }
      ],
      content: '',
      msg_idx: 'REFIDX_gkPJ9RnIT5hdQ/SjMQPDWstG81ovPjw88HwjHppK6Gc='
    }
  ]
```
7.官机艾特
```
msg_elements: [
    {
      content: '[@风](mqqapi://markdown/mention?at_type=1&at_tinyid=459521475)',
      msg_idx: 'REFIDX_WC27RkwWq8TiuraNqz3dV8tG81ovPjw88HwjHppK6Gc='
    }
  ]
```