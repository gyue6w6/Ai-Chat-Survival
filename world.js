// 时代 / 状态配置
window.WORLD_OPTIONS = {
  era: {
    title: '时代',
    options: [
      { id: 'primitive', name: '原始', prompt: '' },
      { id: 'modern',    name: '现代', prompt: '' },
    ],
  },
  state: {
    title: '状态',
    options: [
      { id: 'none', name: '无',   prompt: '' },
      { id: 'doom', name: '末日', prompt: '' },
    ],
  },
  openings: {
    primitive_none: '雨停了，现在是夏末秋初，你醒来在一片温带海岸森林。你从蕨类堆爬出来，左边是海，右边是森林，远处的浆果好像熟了，今天的海风有些咸腥...',
    primitive_doom: '夏末秋初，你醒来在一片温带海岸森林。你浑身湿透从尸体堆爬出来，雾很浓，看不清远处，左边有水声，右边有树影，今天的空气有些腥...好像不是海的味道',
    modern_none:    '你从一个破旧的出租屋醒来，天花板泛黄，摸了摸兜里的钱包还有43块钱，床头柜上放着半瓶矿泉水，手机响了一声，是外卖优惠券和手机电量不足的提示...',
    modern_doom:    '你从冰冷的地面醒来，四周是老旧的墙壁，手里紧紧攥着把生锈的斧子，暗红的痕迹从头上延伸至门外，这里似乎是间废弃已久的卧室...',
  },
};