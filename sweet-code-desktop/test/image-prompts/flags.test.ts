import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFlags,minorSexualized } from '../../scripts/image-prompts/flags.ts';
import { cleanAuthor } from '../../scripts/image-prompts/clean.ts';
test('word boundaries, ambiguous names and minor sexualization',()=>{
 const rules={'real-person':['Elon Musk','Lisa Manobal','Sam Altman','萨姆·奥特曼'],suggestive:['bikini','nude','性感']};
 assert.deepEqual(matchFlags('musk scent Mona Lisa 蒙娜丽莎 奥特曼',rules),[]);
 assert.deepEqual(matchFlags('Elon Muskrat',rules),[]);
 assert.deepEqual(matchFlags('Elon Musk',rules),['real-person']);
 assert.equal(minorSexualized('17 岁 普通人像',[]),false);
 for(const text of ['17 years old bikini','17岁 性感','高中生 nude','loli bikini'])assert.equal(minorSexualized(text,matchFlags(text,rules)),true);
 assert.equal(cleanAuthor('小红书号 xxx'),undefined);
 assert.equal(cleanAuthor('苍何原创实测(公众号文章《测试》)'),'苍何');
 assert.equal(cleanAuthor('关注我的公众号'),undefined);
 assert.equal(cleanAuthor(String.raw`\[OpenNana]\(]\(<https://x.com/example>)`),'OpenNana');
});

import { promises as fs } from 'node:fs';
const fullRules=JSON.parse(await fs.readFile(new URL('../../scripts/image-prompts/flag-rules.json',import.meta.url),'utf8'));
test('IP aliases and precise boundaries',()=>{
 for(const text of ['火影忍者 漩涡鸣人','Jujutsu Kaisen 五条悟','One Piece','Dragon Ball','Pokémon','原神','GTA','Zelda','Mario','Hitman','Cyberpunk 2077','吉卜力','Pixar','Disney','Marvel','DC Comics','Star Wars','哈利波特','Spider-Man'])assert.ok(matchFlags(text,fullRules).includes('ip'),text);
 for(const text of ['胡桃木厨房 walnut still life', 'Sam Altman 奥特曼首推 AI 模型', 'DC voltage power supply','GTAware','Mariole','hitmanship','EVA foam material','eva材质','apple fruit still life','85mm lens Leica style portrait'])assert.ok(!matchFlags(text,fullRules).includes('ip'),text);
});
test('brand visual subjects, fictional brands and photography exclusions',()=>{
 for(const text of ['Apple logo on iPhone packaging','Nike sneaker advertisement','可口可乐瓶广告','麦当劳商标','特斯拉汽车海报','LV logo','Louis Vuitton branded bag'])assert.ok(matchFlags(text,fullRules).includes('brand'),text);
 for(const text of ['Apple 风格自然科普海报', 'YouTube thumbnail portrait poster', 'Instagram food photograph', 'Amazon product listing photograph', 'fictional brand Nike logo','虚构品牌 可口可乐 商标','invented company Apple logo','Leica style shot with 85mm lens','Nike portrait shot on 85mm lens','Apple fruit product photograph','red apple bottle still life','LV 20 level UI','pineapple packaging','Nikey shoe','Amazon rainforest photograph'])assert.ok(!matchFlags(text,fullRules).includes('brand'),text);
 assert.ok(matchFlags('Nike logo in original interface design',fullRules,'stretchcloud').includes('brand'));
});
for(const text of ['a 16-year-old girl in a bikini','a 12-year old in lingerie','15 y/o sexy','十六岁少女 性感 比基尼','17歲 性感','性感，年龄：16','sexy teen girl','preteen bikini','性感的初中女生','女童 泳装 性感','高中女生 泳装 湿身','未成年 泳装'])test('minor rule excludes '+text,()=>assert.equal(minorSexualized(text),true));
for(const text of ['儿童绘本插画，小熊和小兔在森林里','a 25-year-old woman in a bikini','teenage boy playing basketball, no nudity','高中生在教室里读书','young woman in a swimsuit'])test('minor rule retains '+text,()=>assert.equal(minorSexualized(text),false));
test('author paired markup, handles, platform and contacts',()=>{assert.equal(cleanAuthor('@Emmma__0'),'@Emmma__0');assert.equal(cleanAuthor('**名字**'),'名字');assert.equal(cleanAuthor('_名字_'),'名字');assert.equal(cleanAuthor('ぬる(温)'),'ぬる温');for(const p of ['小红书','公众号','X','Twitter'])assert.equal(cleanAuthor(p),undefined);assert.equal(cleanAuthor('Alice，VX:foo'),'Alice,');});
test('negation and design terms do not produce suggestive flags',()=>{for(const text of ['no nudity','no lingerie','not sexualized','无裸露','不要性感','naked glyphs','naked chevron links','naked SVGs','naked inline arrow links','creamy beige, nude, and monochrome palettes'])assert.ok(!matchFlags(text,fullRules).includes('suggestive'),text);});
test('real products retain brand tags beside style and system font mentions do not',()=>{for(const text of ['holding Xiaomi 17 Pro with a cinematic style','showing an iPhone 17 with futuristic aesthetic','Nike logo in a Google Fonts interface'])assert.ok(matchFlags(text,fullRules,'stretchcloud').includes('brand'),text);for(const text of ['Google Fonts interface','-apple-system interface','Apple Pay interface','Apple Color Emoji interface','SF Pro interface'])assert.ok(!matchFlags(text,fullRules,'stretchcloud').includes('brand'),text);assert.ok(!matchFlags('Musk perfume fragrance',fullRules).includes('real-person'));assert.ok(!matchFlags('musk scent',fullRules).includes('real-person'));assert.ok(matchFlags('Musk on a stage',fullRules).includes('real-person'));});
