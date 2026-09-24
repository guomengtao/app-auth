// lib/geo-zh.js — 英文地名 → 中文归属地（唯一真源）
//
// 背景：Vercel 免费头部 x-vercel-ip-country/-region/-city 返回英文
//      （Beijing / Guangzhou / Shandong），而推送给 ev-notifier 的通知需要中文。
//
// 约定：所有推送源在「读取 geo 的那一刻」调用 resolveZhLocation()，
//      把结果以 location_zh 字段放进 payload；
//      消费端（ev_notifier.py）只认这个字段，不再自行做地名映射。
//
// 输出格式：
//   省 市    → "广东 广州"
//   直辖市   → "北京"
//   仅省     → "山东"
//   海外     → "东京" / "新加坡"
//   未命中   → 原文回落（city || region || country）

var CITY_ZH_MAP = {
  // 直辖市
  "Beijing": "北京", "Shanghai": "上海", "Tianjin": "天津", "Chongqing": "重庆",
  // 广东
  "Guangzhou": "广州", "Shenzhen": "深圳", "Dongguan": "东莞", "Foshan": "佛山",
  "Zhuhai": "珠海", "Zhongshan": "中山", "Huizhou": "惠州", "Shantou": "汕头",
  "Jiangmen": "江门", "Zhanjiang": "湛江", "Zhaoqing": "肇庆", "Maoming": "茂名",
  "Jieyang": "揭阳", "Meizhou": "梅州", "Qingyuan": "清远", "Shaoguan": "韶关",
  "Yangjiang": "阳江", "Heyuan": "河源", "Chaozhou": "潮州", "Yunfu": "云浮",
  "Shanwei": "汕尾",
  // 山东
  "Jinan": "济南", "Qingdao": "青岛", "Zibo": "淄博", "Yantai": "烟台",
  "Weifang": "潍坊", "Linyi": "临沂", "Jining": "济宁", "Tai'an": "泰安",
  "Weihai": "威海", "Rizhao": "日照", "Dongying": "东营", "Liaocheng": "聊城",
  "Dezhou": "德州", "Zaozhuang": "枣庄", "Heze": "菏泽", "Binzhou": "滨州",
  // 浙江
  "Hangzhou": "杭州", "Ningbo": "宁波", "Wenzhou": "温州", "Jiaxing": "嘉兴",
  "Shaoxing": "绍兴", "Jinhua": "金华", "Taizhou": "台州", "Huzhou": "湖州",
  "Quzhou": "衢州", "Lishui": "丽水", "Zhoushan": "舟山",
  // 江苏
  "Nanjing": "南京", "Suzhou": "苏州", "Wuxi": "无锡", "Changzhou": "常州",
  "Nantong": "南通", "Xuzhou": "徐州", "Yangzhou": "扬州", "Yancheng": "盐城",
  "Zhenjiang": "镇江", "Huai'an": "淮安", "Lianyungang": "连云港", "Suqian": "宿迁",
  // 四川
  "Chengdu": "成都", "Mianyang": "绵阳", "Deyang": "德阳", "Neijiang": "内江",
  "Nanchong": "南充", "Yibin": "宜宾", "Luzhou": "泸州", "Leshan": "乐山",
  "Zigong": "自贡", "Panzhihua": "攀枝花", "Guang'an": "广安", "Suining": "遂宁",
  "Meishan": "眉山", "Bazhong": "巴中", "Ya'an": "雅安", "Ziyang": "资阳",
  "Dazhou": "达州", "Guangyuan": "广元", "Liangshan": "凉山",
  // 湖北
  "Wuhan": "武汉", "Yichang": "宜昌", "Xiangyang": "襄阳", "Jingzhou": "荆州",
  "Huangshi": "黄石", "Shiyan": "十堰", "Xiaogan": "孝感", "Huanggang": "黄冈",
  "Xianning": "咸宁", "Jingmen": "荆门", "Suizhou": "随州", "Ezhou": "鄂州",
  "Enshi": "恩施",
  // 福建
  "Fuzhou": "福州", "Xiamen": "厦门", "Quanzhou": "泉州", "Zhangzhou": "漳州",
  "Putian": "莆田", "Sanming": "三明", "Nanping": "南平", "Longyan": "龙岩",
  "Ningde": "宁德",
  // 湖南
  "Changsha": "长沙", "Zhuzhou": "株洲", "Xiangtan": "湘潭", "Hengyang": "衡阳",
  "Yueyang": "岳阳", "Changde": "常德", "Yiyang": "益阳", "Chenzhou": "郴州",
  "Shaoyang": "邵阳", "Huaihua": "怀化", "Yongzhou": "永州", "Loudi": "娄底",
  "Zhangjiajie": "张家界", "Xiangxi": "湘西",
  // 河南
  "Zhengzhou": "郑州", "Luoyang": "洛阳", "Kaifeng": "开封", "Xinxiang": "新乡",
  "Anyang": "安阳", "Jiaozuo": "焦作", "Pingdingshan": "平顶山", "Xuchang": "许昌",
  "Luohe": "漯河", "Shangqiu": "商丘", "Zhoukou": "周口", "Zhumadian": "驻马店",
  "Nanyang": "南阳", "Xinyang": "信阳", "Sanmenxia": "三门峡", "Hebi": "鹤壁",
  "Puyang": "濮阳",
  // 河北
  "Shijiazhuang": "石家庄", "Tangshan": "唐山", "Baoding": "保定", "Handan": "邯郸",
  "Xingtai": "邢台", "Cangzhou": "沧州", "Langfang": "廊坊", "Hengshui": "衡水",
  "Zhangjiakou": "张家口", "Chengde": "承德", "Qinhuangdao": "秦皇岛",
  // 辽宁
  "Shenyang": "沈阳", "Dalian": "大连", "Anshan": "鞍山", "Fushun": "抚顺",
  "Benxi": "本溪", "Dandong": "丹东", "Jinzhou": "锦州", "Yingkou": "营口",
  "Fuxin": "阜新", "Liaoyang": "辽阳", "Panjin": "盘锦", "Tieling": "铁岭",
  "Chaoyang": "朝阳", "Huludao": "葫芦岛",
  // 陕西
  "Xi'an": "西安", "Xian": "西安", "Xianyang": "咸阳", "Baoji": "宝鸡",
  "Weinan": "渭南", "Hanzhong": "汉中", "Yulin": "榆林", "Ankang": "安康",
  "Shangluo": "商洛", "Yan'an": "延安", "Tongchuan": "铜川",
  // 云南
  "Kunming": "昆明", "Qujing": "曲靖", "Yuxi": "玉溪", "Dali": "大理",
  "Lijiang": "丽江", "Baoshan": "保山", "Zhaotong": "昭通", "Lincang": "临沧",
  "Pu'er": "普洱", "Honghe": "红河",
  // 安徽
  "Hefei": "合肥", "Wuhu": "芜湖", "Bengbu": "蚌埠", "Huainan": "淮南",
  "Ma'anshan": "马鞍山", "Huaibei": "淮北", "Tongling": "铜陵", "Anqing": "安庆",
  "Huangshan": "黄山", "Chuzhou": "滁州", "Fuyang": "阜阳", "Lu'an": "六安",
  // 江西
  "Nanchang": "南昌", "Ganzhou": "赣州", "Jiujiang": "九江", "Shangrao": "上饶",
  "Yichun": "宜春", "Ji'an": "吉安", "Pingxiang": "萍乡", "Xinyu": "新余",
  "Jingdezhen": "景德镇",
  // 广西
  "Nanning": "南宁", "Liuzhou": "柳州", "Guilin": "桂林", "Wuzhou": "梧州",
  "Beihai": "北海", "Qinzhou": "钦州", "Guigang": "贵港",
  // 山西
  "Taiyuan": "太原", "Datong": "大同", "Yangquan": "阳泉", "Changzhi": "长治",
  "Jincheng": "晋城", "Shuozhou": "朔州", "Jinzhong": "晋中", "Yuncheng": "运城",
  "Xinzhou": "忻州", "Linfen": "临汾", "Luliang": "吕梁",
  // 贵州
  "Guiyang": "贵阳", "Zunyi": "遵义", "Anshun": "安顺", "Liupanshui": "六盘水",
  "Bijie": "毕节", "Tongren": "铜仁",
  // 海南 / 吉林 / 黑龙江
  "Haikou": "海口", "Sanya": "三亚",
  "Changchun": "长春", "Jilin": "吉林", "Siping": "四平", "Tonghua": "通化",
  "Yanbian": "延边", "Baishan": "白山", "Songyuan": "松原", "Baicheng": "白城",
  "Harbin": "哈尔滨", "Qiqihar": "齐齐哈尔", "Daqing": "大庆", "Mudanjiang": "牡丹江",
  "Jiamusi": "佳木斯", "Jixi": "鸡西", "Suihua": "绥化",
  // 甘肃 / 新疆 / 内蒙古 / 宁夏 / 青海 / 西藏
  "Lanzhou": "兰州", "Tianshui": "天水", "Baiyin": "白银", "Jiuquan": "酒泉",
  "Zhangye": "张掖", "Wuwei": "武威", "Qingyang": "庆阳",
  "Urumqi": "乌鲁木齐", "Karamay": "克拉玛依", "Kashgar": "喀什", "Aksu": "阿克苏",
  "Hohhot": "呼和浩特", "Baotou": "包头", "Ordos": "鄂尔多斯", "Chifeng": "赤峰",
  "Yinchuan": "银川", "Shizuishan": "石嘴山", "Wuzhong": "吴忠",
  "Xining": "西宁", "Lhasa": "拉萨", "Shigatse": "日喀则",
  // 港澳台
  "Hong Kong": "香港", "Macau": "澳门", "Macao": "澳门", "Taipei": "台北",
  "Kaohsiung": "高雄", "Taichung": "台中", "Tainan": "台南", "Hsinchu": "新竹",
  // 常见海外
  "Singapore": "新加坡", "Kuala Lumpur": "吉隆坡", "Tokyo": "东京", "Osaka": "大阪",
  "Kyoto": "京都", "Nagoya": "名古屋", "Seoul": "首尔", "Busan": "釜山",
  "Bangkok": "曼谷", "Hanoi": "河内", "Ho Chi Minh City": "胡志明市",
  "Manila": "马尼拉", "Jakarta": "雅加达", "New York": "纽约", "Los Angeles": "洛杉矶",
  "San Francisco": "旧金山", "San Jose": "圣何塞", "Seattle": "西雅图",
  "Chicago": "芝加哥", "Houston": "休斯顿", "Boston": "波士顿", "Dallas": "达拉斯",
  "London": "伦敦", "Manchester": "曼彻斯特", "Paris": "巴黎", "Berlin": "柏林",
  "Frankfurt": "法兰克福", "Amsterdam": "阿姆斯特丹", "Sydney": "悉尼",
  "Melbourne": "墨尔本", "Toronto": "多伦多", "Vancouver": "温哥华",
  "Moscow": "莫斯科", "Dubai": "迪拜",
};

var REGION_ZH_MAP = {
  "Beijing": "北京", "Shanghai": "上海", "Tianjin": "天津", "Chongqing": "重庆",
  "Shandong": "山东", "Guangdong": "广东", "Zhejiang": "浙江", "Jiangsu": "江苏",
  "Sichuan": "四川", "Hubei": "湖北", "Fujian": "福建", "Hunan": "湖南",
  "Henan": "河南", "Hebei": "河北", "Liaoning": "辽宁", "Shaanxi": "陕西",
  "Yunnan": "云南", "Anhui": "安徽", "Jiangxi": "江西", "Guangxi": "广西",
  "Shanxi": "山西", "Guizhou": "贵州", "Hainan": "海南", "Jilin": "吉林",
  "Heilongjiang": "黑龙江", "Gansu": "甘肃", "Xinjiang": "新疆",
  "Inner Mongolia": "内蒙古", "Ningxia": "宁夏", "Qinghai": "青海",
  "Tibet": "西藏", "Hong Kong": "香港", "Macau": "澳门", "Taiwan": "台湾",
  "Hainan Island": "海南",
};

var COUNTRY_ZH_MAP = {
  // 值为 "" 表示「已知但不显示」（国内/港澳台已由 region 覆盖）
  "CN": "", "China": "",
  "SG": "新加坡", "Singapore": "新加坡",
  "JP": "日本", "Japan": "日本",
  "KR": "韩国", "South Korea": "韩国", "Korea": "韩国",
  "TH": "泰国", "Thailand": "泰国",
  "MY": "马来西亚", "Malaysia": "马来西亚",
  "VN": "越南", "Vietnam": "越南",
  "ID": "印尼", "Indonesia": "印尼",
  "PH": "菲律宾", "Philippines": "菲律宾",
  "IN": "印度", "India": "印度",
  "US": "美国", "United States": "美国", "USA": "美国",
  "GB": "英国", "United Kingdom": "英国",
  "DE": "德国", "Germany": "德国",
  "FR": "法国", "France": "法国",
  "NL": "荷兰", "Netherlands": "荷兰",
  "AU": "澳大利亚", "Australia": "澳大利亚",
  "CA": "加拿大", "Canada": "加拿大",
  "RU": "俄罗斯", "Russia": "俄罗斯",
  "BR": "巴西", "Brazil": "巴西",
  "ES": "西班牙", "Spain": "西班牙",
  "IT": "意大利", "Italy": "意大利",
  "AE": "阿联酋", "United Arab Emirates": "阿联酋",
  "HK": "香港", "Hong Kong": "香港",
  "MO": "澳门", "Macau": "澳门", "Macao": "澳门",
  "TW": "台湾", "Taiwan": "台湾",
  // 常见境外国家（境外 IP 的 region 常是看不懂的代码，兜底至少要显示国家中文名）
  "TR": "土耳其", "IL": "以色列", "AZ": "阿塞拜疆", "IR": "伊朗", "IQ": "伊拉克",
  "SA": "沙特", "QA": "卡塔尔", "KW": "科威特", "JO": "约旦", "LB": "黎巴嫩",
  "EG": "埃及", "ZA": "南非", "NG": "尼日利亚", "KE": "肯尼亚", "MA": "摩洛哥",
  "PK": "巴基斯坦", "BD": "孟加拉国", "LK": "斯里兰卡", "NP": "尼泊尔", "MM": "缅甸",
  "KH": "柬埔寨", "LA": "老挝", "MN": "蒙古国", "KZ": "哈萨克斯坦", "UZ": "乌兹别克斯坦",
  "GE": "格鲁吉亚", "AM": "亚美尼亚", "BY": "白俄罗斯", "UA": "乌克兰", "PL": "波兰",
  "CZ": "捷克", "HU": "匈牙利", "RO": "罗马尼亚", "GR": "希腊", "PT": "葡萄牙",
  "IE": "爱尔兰", "SE": "瑞典", "NO": "挪威", "DK": "丹麦", "FI": "芬兰",
  "CH": "瑞士", "AT": "奥地利", "BE": "比利时", "NZ": "新西兰",
  "MX": "墨西哥", "AR": "阿根廷", "CL": "智利", "CO": "哥伦比亚",
  "PE": "秘鲁", "UY": "乌拉圭", "VE": "委内瑞拉", "EC": "厄瓜多尔", "CR": "哥斯达黎加",
};

// 美国一级行政区（Vercel 头部给的是州码，如 IL / CA / GA）——只在 country 为 US 时启用，
// 避免与国内省级代码撞车（REGION_CODE_ZH_MAP 里 MO=澳门，美国 MO=密苏里）。
var US_STATE_ZH_MAP = {
  AL: "亚拉巴马州", AK: "阿拉斯加州", AZ: "亚利桑那州", AR: "阿肯色州", CA: "加利福尼亚州",
  CO: "科罗拉多州", CT: "康涅狄格州", DE: "特拉华州", DC: "华盛顿哥伦比亚特区", FL: "佛罗里达州",
  GA: "佐治亚州", HI: "夏威夷州", ID: "爱达荷州", IL: "伊利诺伊州", IN: "印第安纳州",
  IA: "艾奥瓦州", KS: "堪萨斯州", KY: "肯塔基州", LA: "路易斯安那州", ME: "缅因州",
  MD: "马里兰州", MA: "马萨诸塞州", MI: "密歇根州", MN: "明尼苏达州", MS: "密西西比州",
  MO: "密苏里州", MT: "蒙大拿州", NE: "内布拉斯加州", NV: "内华达州", NH: "新罕布什尔州",
  NJ: "新泽西州", NM: "新墨西哥州", NY: "纽约州", NC: "北卡罗来纳州", ND: "北达科他州",
  OH: "俄亥俄州", OK: "俄克拉何马州", OR: "俄勒冈州", PA: "宾夕法尼亚州", RI: "罗得岛州",
  SC: "南卡罗来纳州", SD: "南达科他州", TN: "田纳西州", TX: "得克萨斯州", UT: "犹他州",
  VT: "佛蒙特州", VA: "弗吉尼亚州", WA: "华盛顿州", WV: "西弗吉尼亚州", WI: "威斯康星州",
  WY: "怀俄明州",
};

// Vercel / ip-api 常见拼写差异
var REGION_ALIAS = {
  "Nei Mongol": "Inner Mongolia",
  "Xizang": "Tibet",
  "Xinjiang Uygur": "Xinjiang",
  "Guangxi Zhuang": "Guangxi",
  "Ningxia Hui": "Ningxia",
  "Inner Mongolia Autonomous Region": "Inner Mongolia",
  "Tibet Autonomous Region": "Tibet",
  "Guangdong Sheng": "Guangdong",
};

// key 归一：去首尾空白/撇号、合并空格、去行政后缀
function normKey(v) {
  return String(v || "").trim()
    .replace(/[\u2019'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(City|Shi|Sheng|Prefecture|Province|Autonomous Region)$/i, "");
}

function lookup(map, value) {
  if (!value) return "";
  var raw = String(value).trim();
  if (map[raw]) return map[raw];
  var key = normKey(raw);
  if (map[key]) return map[key];
  var lower = key.toLowerCase();
  for (var k in map) {
    if (k.toLowerCase() === lower) return map[k];
  }
  return "";
}

// 国家名/国家码查询：未收录返回 null，"已知但不显示"返回 ""
function lookupCountry(country) {
  if (!country) return null;
  var raw = String(country).trim();
  if (COUNTRY_ZH_MAP.hasOwnProperty(raw)) return COUNTRY_ZH_MAP[raw];
  var key = normKey(raw).toLowerCase();
  for (var k in COUNTRY_ZH_MAP) {
    if (k.toLowerCase() === key) return COUNTRY_ZH_MAP[k];
  }
  return null;
}

// ⚠️ Vercel 的 `x-vercel-ip-country-region` 对国内 IP 返回的是**省级 ISO 代码**（如 SD=山东、GD=广东、BJ=北京），
//    而不是英文省名，所以必须再有一张「代码 → 中文」映射，否则省/直辖市永远显示为空。
//    只在国家为 CN 时启用，避免与美国州码撞车（SD 南达科他 / MO 密苏里 / HI 夏威夷 / NM 新墨西哥 …）。
var REGION_CODE_ZH_MAP = {
  BJ: "北京", TJ: "天津", HE: "河北", SX: "山西", NM: "内蒙古", LN: "辽宁", JL: "吉林", HL: "黑龙江",
  SH: "上海", JS: "江苏", ZJ: "浙江", AH: "安徽", FJ: "福建", JX: "江西", SD: "山东", HA: "河南",
  HB: "湖北", HN: "湖南", GD: "广东", GX: "广西", HI: "海南", CQ: "重庆", SC: "四川", GZ: "贵州",
  YN: "云南", XZ: "西藏", SN: "陕西", GS: "甘肃", QH: "青海", NX: "宁夏", XJ: "新疆",
  TW: "台湾", HK: "香港", MO: "澳门",
};

function isChinaCode(country) {
  var c = String(country || "").trim();
  if (!c) return true; // 没给国家时不排斥（本地/测试场景）
  return /^(CN|CHN|China|中国)$/i.test(c);
}

function isUsCode(country) {
  var c = String(country || "").trim();
  if (!c) return false; // 国家未知时不猜，避免误译
  return /^(US|USA|United States|美国)$/i.test(c);
}

// ⚠️ Vercel 的 x-vercel-ip-city 对非 ASCII 城市名是 **percent-encoded**（如 Maghār → Magh%C4%81r、
//    上海 → %E4%B8%8A%E6%B5%B7）。历史上全链路都没有 decode，导致后台出现 `Z · Magh%C4%81r`。
function decodeGeoValue(value) {
  var raw = String(value || "").trim();
  if (!raw || raw.indexOf("%") < 0) return raw;
  try {
    var out = decodeURIComponent(raw);
    // 解码失败（非法 % 序列）会抛错，这里退化为原值
    return out || raw;
  } catch (e) {
    return raw;
  }
}

// 单个「英文省名/省级代码」→ 中文省名（供页面等只拿到一个字段的场景复用，避免各处自己拼）
function regionZhOf(value, country) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  var mapped = lookup(REGION_ZH_MAP, REGION_ALIAS[raw] || raw);
  if (mapped) return mapped;
  if (isChinaCode(country)) {
    return REGION_CODE_ZH_MAP[raw.toUpperCase()] || "";
  }
  if (isUsCode(country)) {
    return US_STATE_ZH_MAP[raw.toUpperCase()] || "";
  }
  return "";
}

// 单个「英文城市名」→ 中文城市名
function cityZhOf(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  // 已经是中文（ip-api lang=zh-CN / 腾讯 / 解码后的 Vercel 头）→ 直接返回，别再查英文字典
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  return lookup(CITY_ZH_MAP, raw);
}

// 主入口：{ country, region, city }（英文/代码）→ 中文归属地
function resolveZhLocation(geo) {
  geo = geo || {};
  var city = decodeGeoValue(geo.city);          // Vercel 头部可能是 percent-encoded
  var region = String(geo.region || "").trim();
  var country = String(geo.country || "").trim();

  // zh_region / zh_city：外部已备好的中文（如 ip_lookups 里 ip-api lang=zh-CN 的结果），优先于本地映射
  var cityZh = String(geo.zh_city || "").trim() || cityZhOf(city);
  var regionZh = String(geo.zh_region || "").trim() || regionZhOf(region, country);

  var countryZh = lookupCountry(country);       // "" = 已知国内（不显示），null = 未收录

  if (cityZh) {
    var head = regionZh || countryZh;
    return head && head !== cityZh ? head + " " + cityZh : cityZh;
  }
  if (regionZh) return city ? regionZh + " " + city : regionZh;
  // 境外 IP 常常只有英文城市名（Irvine / Baku）：宁可显示「美国 Irvine」也不要裸奔州码
  if (countryZh) return city ? countryZh + " " + city : countryZh;
  if (countryZh === "") return "";   // 已知国内但省市都没匹配上 → 不显示，避免出现 "CN"

  var fallback = city || region || "";
  if (fallback) return fallback;
  // 只剩看不懂的国家码 → 宁可不显示
  return country.length === 2 ? "" : country;
}

// 按「来源成组」挑中文省市，避免混搭出矛盾组合。
// 背景：ip_lookups 同时存了腾讯的 region_zh/city_zh 和 ip-api 的 region/city，
// 若「腾讯给省 + ip-api 给市」混着用，会出现「上海 · 杭州」这种明显不一致的展示。
function pickCnPair(src) {
  src = src || {};
  var hasTencent = Boolean(String(src.region_zh || "").trim() || String(src.city_zh || "").trim() || String(src.district || "").trim());
  if (hasTencent) {
    return { region: String(src.region_zh || "").trim(), city: String(src.city_zh || "").trim(), source: "tencent" };
  }
  return { region: String(src.region || "").trim(), city: String(src.city || "").trim(), source: "ip-api" };
}

// 后台「城市 / 地区」列专用：把 ip_lookups 与 Vercel 头部三组数据**按来源成组**挑一套出来，
// 绝不跨源拼接（历史 bug：ip_lookups 的中文市 + Vercel 的英文州码 → 「IL · 芝加哥」）。
//
// 入参：
//   region_zh / city_zh  → 腾讯组（ip_lookups）
//   region / city        → ip-api 组（ip_lookups，已是中文）
//   raw_region / raw_city→ Vercel 请求头组（英文 / ISO 代码 / percent-encoded）
//   country              → 国家码（US/CN/...），用于兜底出「美国」而不是 "IL"
function resolveDisplayGeo(src) {
  src = src || {};
  var tencentRegion = String(src.region_zh || "").trim();
  var tencentCity = String(src.city_zh || "").trim();
  if (tencentRegion || tencentCity) {
    return { region: tencentRegion, city: tencentCity, source: "tencent" };
  }

  var storeRegion = String(src.region || "").trim();
  var storeCity = String(src.city || "").trim();
  if (storeRegion || storeCity) {
    return { region: storeRegion, city: storeCity, source: "ip-api" };
  }

  // 兜底：Vercel 头部。region 可能是省级代码（CN）/ 州码（US）/ 数字区号（TR），
  // 翻译不出来时**绝不能原样展示**，改用国家中文名顶上。
  var rawRegion = String(src.raw_region || "").trim();
  var rawCity = decodeGeoValue(src.raw_city);
  var regionZh = regionZhOf(rawRegion, src.country);
  var cityZh = cityZhOf(rawCity) || rawCity;
  var countryZh = lookupCountry(src.country);
  if (countryZh === null) countryZh = "";
  if (/^CN$/i.test(String(src.country || "").trim())) countryZh = "中国";

  return {
    region: regionZh || countryZh,
    city: cityZh,
    source: regionZh ? "vercel" : "vercel-country",
  };
}

// 拼接「省 市」与「区县」：避免出现「北京北京朝阳区」「内蒙古呼和浩特呼和浩特市新城区」
function joinDistrict(locationZh, districtZh) {
  var loc = String(locationZh || "").trim();
  var dist = String(districtZh || "").trim();
  if (!loc) return dist;
  if (!dist) return loc;

  var locFlat = loc.replace(/\s+/g, "");
  var distFlat = dist.replace(/\s+/g, "");

  // 区县自带完整前缀（"北京朝阳区"）或反向包含 → 直接用信息量更大的那个
  if (distFlat.indexOf(locFlat) === 0) return dist;
  if (locFlat.indexOf(distFlat) === 0) return loc;

  // 区县自带市名前缀（"广州市天河区"）→ 去掉重复的市名及其后的「市/省」字
  var maxN = Math.min(4, locFlat.length, distFlat.length);
  for (var n = maxN; n >= 2; n--) {
    if (distFlat.indexOf(locFlat.slice(-n)) === 0) {
      return loc + distFlat.slice(n).replace(/^[市省](?=.)/, "");
    }
  }
  return loc + distFlat;
}

// 完整版：{country, region, city, district} → 三个中文字段
function resolveZhLocationFull(geo) {
  geo = geo || {};
  var locationZh = resolveZhLocation(geo);
  var districtZh = String(geo.district || geo.district_zh || "").trim();
  return {
    location_zh: locationZh,
    district_zh: districtZh,
    location_full_zh: joinDistrict(locationZh, districtZh),
  };
}

module.exports = {
  CITY_ZH_MAP: CITY_ZH_MAP,
  REGION_ZH_MAP: REGION_ZH_MAP,
  COUNTRY_ZH_MAP: COUNTRY_ZH_MAP,
  resolveZhLocation: resolveZhLocation,
  resolveZhLocationFull: resolveZhLocationFull,
  regionZhOf: regionZhOf,
  cityZhOf: cityZhOf,
  pickCnPair: pickCnPair,
  resolveDisplayGeo: resolveDisplayGeo,
  decodeGeoValue: decodeGeoValue,
  US_STATE_ZH_MAP: US_STATE_ZH_MAP,
  REGION_CODE_ZH_MAP: REGION_CODE_ZH_MAP,
  joinDistrict: joinDistrict,
};
