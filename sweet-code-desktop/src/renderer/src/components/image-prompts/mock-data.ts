import { MOCK_JPEGS } from "./mock-jpegs";
import type { ImagePromptCategory, ImagePromptDetail, ImagePromptFlag, ImagePromptLang, ImagePromptLicense, ImagePromptModel, ImagePromptSource, ImagePromptVariant } from "@shared/types";

// dev:web 用的样例。内容都是自己写的，和真实数据集无关。

export const MOCK_SOURCES: ImagePromptSource[] = [
  { id: "demo-own", name: "示例·原创库", repoUrl: "https://example.com/demo-own", license: "MIT", licenseNote: "MIT 许可，可以自由使用。", count: 0 },
  { id: "demo-community", name: "示例·社区精选", repoUrl: "https://example.com/demo-community", license: "CC-BY-4.0", attribution: "Prompts from 示例·社区精选, licensed under CC BY 4.0.", count: 0 },
  { id: "demo-repost", name: "示例·转载合集", repoUrl: "https://example.com/demo-repost", license: "none", licenseNote: "来源没有写许可证，里面多是转载他人的内容。", count: 0 },
  { id: "demo-murky", name: "示例·许可不明库", repoUrl: "javascript:alert(1)", license: "unclear", licenseNote: "这条故意放了个不安全的链接，用来确认界面不会把它渲染成链接。", count: 0 },
];

interface Seed {
  t: string; en?: string; cat: ImagePromptCategory; zh?: string; enText?: string; steps?: string[];
  img?: [number, number]; // 缩略图宽高；没有就是纯文字卡片
  tags?: string[]; author?: string; src?: string; lic?: ImagePromptLicense; third?: boolean; flags?: ImagePromptFlag[];
  models?: ImagePromptModel[]; exact?: string; ratio?: string; size?: string; ref?: boolean; url?: string; attr?: string; also?: string[];
  feat?: boolean; fav?: boolean; vars?: boolean;
}

const LONG = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段：画面里有一条蜿蜒的石板小路，路两旁是被雨水洗过的老房子，屋檐下挂着一排暖黄色的灯笼，远处的山被薄雾遮住一半，近处的水洼里倒映着灯光和行人的剪影，整体色调偏青灰，只有灯笼是点睛的暖色，镜头略微仰拍，保留一点颗粒感。`).join("\n\n");

const SEEDS: Seed[] = [
  { t: "雨夜小巷里的暖灯", en: "Warm lanterns in a rainy alley", cat: "photo", zh: "雨后的夜晚，窄窄的石板小巷，屋檐下一排暖黄色灯笼，地面水洼倒映灯光，远处有撑伞的人影，35mm 镜头，胶片颗粒，青灰色调。", enText: "A narrow cobbled alley after rain at night, warm yellow lanterns under the eaves, puddles reflecting the light, a distant figure with an umbrella, 35mm lens, film grain, teal-grey palette.", img: [3, 4], tags: ["夜景", "胶片", "街拍"], src: "demo-own", models: ["gpt-image-2.5"], ratio: "3:4", size: "1024x1536", feat: true, fav: true },
  { t: "极简咖啡海报", en: "Minimal coffee poster", cat: "poster", zh: "一张极简风格的咖啡店海报，米白色背景，中间一杯冒热气的黑咖啡的线描插画，上方用大号无衬线字体写「慢一点」，下方小字写店名[店名]和营业时间[时间]。", img: [4, 5], tags: ["海报", "排版", "极简"], src: "demo-own", vars: true, ratio: "4:5", feat: true },
  { t: "运动鞋产品图", en: "Sneaker product shot", cat: "product", enText: "A clean studio product shot of a white running sneaker floating at a slight angle, soft shadow below, pale grey seamless background, crisp rim light from the left, ultra sharp, e-commerce style.", img: [1, 1], tags: ["电商", "棚拍"], src: "demo-community", author: "Mira L.", models: ["gpt-image-2"], ratio: "1:1", attr: "Mira L. via 示例·社区精选 (CC BY 4.0)", url: "https://example.com/post/101" },
  { t: "记账 App 首页", en: "Budget app home screen", cat: "ui", zh: "手机端记账 App 的首页界面截图：顶部是本月结余的大数字，中间是一条七天支出的柱状图，下面是按分类列出的最近账单，圆角卡片，柔和的绿色主色，留白充足。", img: [9, 16], tags: ["App", "界面"], src: "demo-own", ratio: "9:16" },
  { t: "咖啡豆知识信息图", cat: "infographic", zh: "一张竖版信息图，标题「一颗咖啡豆的旅程」，从种植、采摘、水洗、烘焙到冲泡共五个步骤，用图标加两行短说明，路线用虚线串起来，暖棕色配奶油色。", tags: ["信息图", "科普"], src: "demo-community", author: "阿木", ratio: "2:3" },
  { t: "水彩风森林狐狸", en: "Watercolor forest fox", cat: "illustration", enText: "A fox curled up on a mossy log in a misty forest, soft watercolor with visible paper texture, loose washes of green and amber, gentle edges, children's book illustration.", img: [4, 3], tags: ["水彩", "绘本"], src: "demo-own", ratio: "4:3", fav: true },
  { t: "机甲少女角色设定", en: "Mecha girl character sheet", cat: "character", zh: "原创的机甲少女角色设定图：正面、侧面、背面三视图并排，银白色装甲配青色发光线条，旁边附表情小图和配色色卡，浅灰背景。", img: [16, 9], tags: ["设定图", "原创角色"], src: "demo-community", author: "Kuro", flags: ["ip"], models: ["gpt-image-2.5"], ratio: "16:9", third: true, attr: "Kuro / 示例·社区精选" },
  { t: "旧书店门面", cat: "space", zh: "一家开在街角的二手书店门面，木质招牌，门口摆着几摞旧书，橱窗里一只猫在睡觉，黄昏的光从侧面打过来，写实风格。", img: [4, 3], tags: ["街景", "写实"], src: "demo-own", ratio: "4:3" },
  { t: "把照片换成油画风", en: "Turn the photo into an oil painting", cat: "edit", zh: "保持人物的姿势、构图和表情不变，把整张参考照片重绘成厚涂油画风格，能看到笔触，色彩饱和度稍微提高。", img: [3, 4], tags: ["改图", "风格迁移"], src: "demo-own", ref: true, ratio: "3:4" },
  { t: "给宠物做一张证件照", cat: "fun", zh: "把参考图里的宠物做成一张严肃的证件照：纯蓝背景，正面端坐，穿一件小西装，下方印上姓名[宠物名字]和编号[编号]。", tags: ["有趣", "宠物"], src: "demo-repost", third: true, ref: true, vars: true, author: "团子" },
  { t: "品牌 Logo 草图：山与云", en: "Logo sketch: mountain and cloud", cat: "brand", zh: "一个简洁的徽标：由一座山的轮廓和一朵云叠在一起组成，单色，粗线条，可以放大缩小都清晰，白色背景，留出足够边距。", enText: "A simple emblem combining the outline of a mountain and a cloud, single color, bold strokes, scalable and clean, white background with generous margins.", img: [1, 1], tags: ["Logo", "矢量风"], src: "demo-own", ratio: "1:1" },
  { t: "咖啡店人像写真", cat: "portrait", zh: "一位穿米色针织衫的年轻女生坐在咖啡店靠窗的位置，低头看书，窗外的自然光落在她侧脸上，浅景深，人物面部清晰，整体温柔安静。", img: [4, 5], tags: ["人像", "自然光"], src: "demo-community", author: "Sora", flags: ["real-person"], ratio: "4:5", third: true },
  { t: "赛博朋克夜市", en: "Cyberpunk night market", cat: "illustration", enText: "A crowded cyberpunk night market in the rain, neon signs in magenta and cyan, steam from food stalls, vendors in translucent raincoats, dense detail, cinematic wide shot.", img: [16, 9], tags: ["赛博朋克", "霓虹"], src: "demo-repost", third: true, author: "neo_88", flags: ["suggestive"], models: ["gpt-image-2"] },
  { t: "三步画一只猫", cat: "illustration", steps: ["第一步：用简单的圆形和三角形画出一只坐着的猫的轮廓，铅笔草图风格。", "第二步：在草图上勾出干净的黑色线稿，保留猫尾巴的弧度。", "第三步：给线稿上色，毛色用奶油色加浅橘色，背景是淡蓝色的纯色。"], img: [1, 1], tags: ["分步骤", "猫"], src: "demo-own", ratio: "1:1", feat: true },
  { t: "婚礼请柬排版", cat: "poster", zh: "一张竖版婚礼请柬：深绿色底，金色细线边框，中间是新人姓名[新郎]与[新娘]，下面一行日期[日期]和地点[地点]，字体优雅，四角点缀橄榄枝。", tags: ["请柬", "排版"], src: "demo-own", vars: true },
  { t: "智能音箱电商主图", cat: "product", enText: "Hero image for a smart speaker listing: the speaker on a light wooden shelf next to a plant, morning sunlight through sheer curtains, shallow depth of field, lifestyle photography.", img: [1, 1], tags: ["电商", "生活方式"], src: "demo-community", author: "J. Park", ratio: "1:1" },
  { t: "天气 App 深色模式", cat: "ui", zh: "天气 App 的深色模式主界面：大号当前温度，下面是未来 24 小时的折线图和一排小图标，背景是深蓝渐变，数字使用细体字。", img: [9, 16], tags: ["App", "深色"], src: "demo-own", ratio: "9:16" },
  { t: "城市地铁线路图", cat: "infographic", zh: "为一座虚构的城市画一张地铁线路图，五条线分别用不同颜色，站点用圆点，换乘站用大圆圈，横平竖直加四十五度折线，附图例。", tags: ["线路图", "图表"], src: "demo-own", ratio: "1:1" },
  { t: "超长场景描述（测试滚动）", cat: "other", zh: LONG, img: [4, 3], tags: ["长文本"], src: "demo-own", ratio: "4:3" },
  { t: "漫画分镜：下雨天", cat: "character", steps: ["第 1 格：女孩站在公交站台，抬头看天，开始下雨。", "第 2 格：一个男孩把伞悄悄递过来，自己站在雨里。", "第 3 格：两人共撑一把伞走远，只留一个背影，地上的水洼映着路灯。"], tags: ["漫画", "分镜"], src: "demo-community", author: "Hana", ratio: "3:2" },
  { t: "清晨海边的剪影", en: "Seaside silhouette at dawn", cat: "photo", zh: "清晨的海边，一个人的剪影站在礁石上，天空从橙粉渐变到淡蓝，海面有细碎的反光，长曝光让海浪像雾一样。", img: [3, 2], tags: ["风光", "长曝光"], src: "demo-own", ratio: "3:2", fav: true },
  { t: "极简客厅设计", cat: "space", enText: "A minimalist living room with a low linen sofa, a round oak coffee table, a single large plant, white walls and soft daylight, interior design magazine photograph.", img: [4, 3], tags: ["室内", "极简"], src: "demo-community", author: "Elin", ratio: "4:3" },
  { t: "给人物换一套衣服", cat: "edit", zh: "只把参考图里人物的上衣换成深蓝色的牛仔外套，其他地方包括脸、发型、背景和光线都保持不变。", tags: ["改图", "换装"], src: "demo-own", ref: true },
  { t: "表情包：打工人", cat: "fun", zh: "一只圆滚滚的小黄鸭戴着耳机敲键盘，眼神放空，旁边飘着一行字「再改一版就下班」，贴纸风格，白色描边，透明背景。", img: [1, 1], tags: ["表情包", "贴纸"], src: "demo-repost", third: true, author: "鸭鸭", ratio: "1:1" },
  { t: "手作蜡烛品牌视觉", cat: "brand", zh: "一个手作蜡烛品牌的视觉展示：包装盒、标签和手提袋放在一起，米色纸张质感，深棕色字体，旁边有一枝干花，柔和的自然光。", img: [3, 2], tags: ["包装", "品牌"], src: "demo-own", ratio: "3:2" },
  { t: "老照片修复", cat: "edit", enText: "Restore the old photograph: remove scratches and creases, repair torn corners, keep the original faces and clothing exactly as they are, gently add natural color.", tags: ["修复", "老照片"], src: "demo-community", author: "R. Vale", ref: true },
  { t: "太空站里的花园", en: "A garden inside a space station", cat: "illustration", enText: "A lush hydroponic garden inside a space station, curved glass ceiling showing Earth, astronauts watering plants, warm and hopeful mood, detailed sci-fi concept art.", img: [16, 9], tags: ["科幻", "概念图"], src: "demo-murky", third: true, author: "Orion", ratio: "16:9" },
  { t: "婴儿用品电商图", cat: "product", zh: "一组婴儿用品的电商展示图：奶瓶、围兜和小袜子整齐排列在浅粉色背景上，俯拍，阴影柔和，画面干净清爽。", img: [1, 1], tags: ["电商", "俯拍"], src: "demo-repost", third: true, flags: ["brand"], ratio: "1:1" },
  { t: "读书会活动海报", cat: "poster", zh: "社区读书会的活动海报：暖黄色背景，一摞书和一杯茶的插画，大标题「周六读书会」，时间[时间]，地点[地点]，下方留出二维码的位置。", img: [3, 4], tags: ["海报", "活动"], src: "demo-own", vars: true, ratio: "3:4" },
  { t: "电商后台数据看板", cat: "ui", enText: "A web dashboard for an online store: left sidebar navigation, top row of four KPI cards, a large line chart of weekly sales, and a table of recent orders. Light theme, rounded corners, blue accent.", img: [16, 9], tags: ["后台", "看板"], src: "demo-community", author: "Dae", ratio: "16:9" },
  { t: "奶奶的厨房", cat: "photo", zh: "一间老式厨房的特写，木质橱柜，铁锅里冒着热气，窗台上晒着干辣椒，傍晚的光线温暖，有生活气息，不要出现人物。", tags: ["生活", "写实"], src: "demo-own", ratio: "4:3" },
  { t: "冒险家角色立绘", cat: "character", zh: "一位戴宽檐帽的女冒险家立绘，背着大背包，手握一张旧地图，站在山崖边回头微笑，半写实的游戏立绘风格，背景虚化。", img: [3, 4], tags: ["立绘", "游戏"], src: "demo-community", author: "Kuro", flags: ["ip"], third: true, ratio: "3:4" },
  { t: "城市天际线日落", cat: "photo", enText: "A wide city skyline at sunset seen from a rooftop, the sky glowing orange to violet, glass towers catching the last light, a few birds in the distance, high dynamic range.", img: [16, 9], tags: ["城市", "日落"], src: "demo-own", ratio: "16:9" },
  { t: "极简字体海报：Hello", cat: "poster", enText: "A bold typographic poster with the single word HELLO in oversized rounded letters, each letter a different pastel color, off-white background, lots of breathing room.", img: [4, 5], tags: ["字体", "排版"], src: "demo-community", author: "Tao", ratio: "4:5" },
  { t: "宠物咖啡馆Logo", cat: "brand", zh: "一个宠物咖啡馆的 Logo：一只猫和一只小狗共用一个咖啡杯，圆形徽标，手绘线条，两种颜色，下方写店名[店名]。", tags: ["Logo", "手绘"], src: "demo-own", vars: true },
  { t: "手账风周计划", cat: "infographic", zh: "手账风格的一周计划页：七天的格子，每格有不同颜色的胶带装饰，右侧留一栏「本周目标」，米色纸张纹理，手写字体。", img: [3, 4], tags: ["手账", "计划"], src: "demo-own", ratio: "3:4" },
  { t: "古风庭院", cat: "space", zh: "一座江南古风庭院，白墙黑瓦，月洞门，池塘里有几尾锦鲤，岸边有柳树，细雨朦胧，水墨与写实结合。", img: [4, 3], tags: ["古风", "园林"], src: "demo-own", models: ["gpt-image-2.5"], ratio: "4:3" },
  { t: "无出处的小练习", cat: "other", zh: "画一个红色的苹果，放在木桌上，背景是白墙，光线从左边来。", tags: ["入门"], src: "demo-own" },
  { t: "星空下的帐篷", en: "Tent under the stars", cat: "photo", zh: "夜晚荒野里一顶亮着灯的橙色帐篷，头顶是银河，远处有山的轮廓，长曝光星空摄影，前景有一点草地。", enText: "A glowing orange tent in the wild at night under the Milky Way, mountains in the distance, long-exposure astrophotography, a little grass in the foreground.", img: [3, 2], tags: ["星空", "露营"], src: "demo-own", ratio: "3:2", feat: true },
];

export interface MockEntry extends ImagePromptDetail { thumbData?: string }

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const hex = (n: number) => n.toString(16).padStart(16, "0").slice(-16);

function jpegThumb(seed: string, w: number, h: number): string {
  const list = MOCK_JPEGS[`${w}x${h}`] ?? MOCK_JPEGS["4x3"];
  return `data:image/jpeg;base64,${list[hash(seed) % list.length]}`;
}

function variants(s: Seed): ImagePromptVariant[] {
  if (s.steps) return [{ lang: "zh", steps: s.steps.map((text, i) => ({ text, label: ["打草稿", "勾线稿", "上色"][i] })) }];
  const out: ImagePromptVariant[] = [];
  if (s.zh) out.push({ lang: "zh", steps: [{ text: s.zh }] });
  if (s.enText) out.push({ lang: "en" as ImagePromptLang, steps: [{ text: s.enText }] });
  return out;
}

export function buildMockEntries(): MockEntry[] {
  return SEEDS.map((s, i) => {
    const vs = variants(s);
    const first = vs[0].steps[0].text;
    const [w, h] = s.img ?? [0, 0];
    const cleanExcerpt = first.replace(/\s+/g, " ").slice(0, 140);
    return {
      id: hex(hash(s.t) * 7919 + i),
      title: s.t,
      titleEn: s.en,
      excerpt: cleanExcerpt,
      category: s.cat,
      tags: s.tags ?? [],
      langs: vs.map((v) => v.lang),
      models: s.models ?? ["gpt-image-2", "gpt-image-2.5"].slice(i % 3 === 0 ? 1 : 0) as ImagePromptModel[],
      ratio: s.ratio,
      needsReference: !!s.ref,
      multiStep: !!s.steps,
      author: s.author,
      source: s.src ?? "demo-own",
      license: s.lic ?? MOCK_SOURCES.find((x) => x.id === (s.src ?? "demo-own"))?.license ?? "MIT",
      thirdParty: !!s.third,
      flags: s.flags ?? [],
      featured: !!s.feat,
      hasThumb: !!s.img,
      thumbW: s.img ? 480 : undefined,
      thumbH: s.img ? Math.round((480 * h) / w) : undefined,
      favorite: !!s.fav,
      variants: vs,
      modelExact: s.exact ?? (i % 5 === 0 ? "gpt-image-2.5-demo" : undefined),
      size: s.size,
      sourceUrl: s.url ?? (i % 4 === 0 ? `https://example.com/post/${i}` : i === 6 ? "javascript:alert(1)" : undefined),
      attribution: s.attr,
      alsoIn: s.also ?? (i % 7 === 0 ? ["demo-repost"] : []),
      hasVars: !!s.vars,
      thumbData: s.img ? jpegThumb(s.t, w, h) : undefined,
    };
  });
}
