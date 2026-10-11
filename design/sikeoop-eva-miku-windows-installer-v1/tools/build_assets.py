#!/usr/bin/env python3
"""Build a Windows installer design package; never installs or changes the app."""
from pathlib import Path
from copy import deepcopy
import argparse
import html
import json
import math
import re
import xml.etree.ElementTree as ET
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parents[1]
NS = 'http://www.w3.org/2000/svg'
INK = 'http://www.inkscape.org/namespaces/inkscape'
ET.register_namespace('', NS)
ET.register_namespace('inkscape', INK)
W, H, SIDEBAR = 1040, 660, 364
P = dict(bg='#0B0D15', surface='#131420', raised='#1C1C2C', line='#343247',
         ink='#F2F3FA', muted='#B0ADC4', faint='#8E8CA5', aqua='#5CE1E6',
         violet='#A58BFA', lime='#C5F66F', pink='#FF71B8', error='#FF839A')
FONT = 'Segoe UI, Microsoft YaHei UI, PingFang SC, sans-serif'
DEFS = '''<linearGradient id="shell-gradient" x2="1" y2="1"><stop stop-color="#131421"/><stop offset="1" stop-color="#0D1018"/></linearGradient>
<linearGradient id="sidebar-gradient" x2=".7" y2="1"><stop stop-color="#211930"/><stop offset="1" stop-color="#131222"/></linearGradient>
<linearGradient id="sidebar-fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#131222" stop-opacity="0"/><stop offset=".52" stop-color="#131222" stop-opacity=".38"/><stop offset="1" stop-color="#131222"/></linearGradient>
<linearGradient id="button-gradient" x2="1" y2="1"><stop stop-color="#6CEAE9"/><stop offset="1" stop-color="#4CD4E1"/></linearGradient>
<linearGradient id="progress-gradient"><stop stop-color="#A58BFA"/><stop offset="1" stop-color="#5CE1E6"/></linearGradient>
<radialGradient id="sidebar-aura"><stop stop-color="#5B398A" stop-opacity=".54"/><stop offset="1" stop-color="#161324" stop-opacity="0"/></radialGradient>
<clipPath id="shell-clip"><rect x="1" y="1" width="1038" height="658" rx="14"/></clipPath>
<clipPath id="sidebar-clip"><rect x="1" y="1" width="363" height="658" rx="14"/></clipPath>'''

def attrs(**a): return ' '.join(f'{k.replace("_", "-")}="{html.escape(str(v), quote=True)}"' for k,v in a.items())
def path(d, **a): return f'<path d="{d}" {attrs(**a)}/>'
def rect(x,y,w,h,fill,rx=0,**a): return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" {attrs(**a)}/>'
def circle(x,y,r,**a): return f'<circle cx="{x}" cy="{y}" r="{r}" {attrs(**a)}/>'
def line(x1,y1,x2,y2,**a): return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" {attrs(**a)}/>'
def group(body,**a): return f'<g {attrs(**a)}>{body}</g>'
def text(x,y,s,size=16,color=None,weight=400,spacing=0,anchor=None,**extra):
    a=dict(x=x,y=y,font_size=size,fill=color or P['ink'],font_weight=weight,letter_spacing=spacing,**extra)
    if anchor: a['text_anchor']=anchor
    return f'<text {attrs(**a)}>{html.escape(s)}</text>'
def layer(i,label,body): return f'<g id="{i}" inkscape:groupmode="layer" inkscape:label="{html.escape(label)}">{body}</g>'
def action(name,body,label=None): return group(body,data_action=name,role='button',tabindex='0',aria_label=label or name)
def svg(body,w,h,title,defs=None):
    return f'<svg xmlns="{NS}" xmlns:inkscape="{INK}" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONT}"><title>{html.escape(title)}</title><desc>Windows installer interface design. Native editable vectors, no embedded raster. Design only, no executable installer.</desc><defs>{DEFS if defs is None else defs}</defs>{body}</svg>'

class Outliner:
    def __init__(self,font,regular_index,bold_index):
        self.fonts=[TTFont(font,fontNumber=regular_index),TTFont(font,fontNumber=bold_index)]
        self.cache={}
    def glyph(self,char,bold):
        if (char,bold) not in self.cache:
            f=self.fonts[bold]; name=f.getBestCmap().get(ord(char))
            if not name: raise ValueError(f'Missing glyph {char!r}')
            pen=SVGPathPen(f.getGlyphSet()); f.getGlyphSet()[name].draw(pen)
            self.cache[char,bold]=pen.getCommands(),f['hmtx'][name][0],f['head'].unitsPerEm
        return self.cache[char,bold]
    def convert(self,content):
        root=ET.fromstring(content)
        def visit(parent):
            for i,el in enumerate(list(parent)):
                if el.tag==f'{{{NS}}}text':
                    s=''.join(el.itertext()); size=float(el.get('font-size','16')); spacing=float(el.get('letter-spacing','0'))
                    gl=[self.glyph(c,int(float(el.get('font-weight','400'))>=550)) for c in s]
                    width=sum(a*size/u for _,a,u in gl)+max(0,len(s)-1)*spacing
                    x=float(el.get('x','0')); y=float(el.get('y','0'))
                    if el.get('text-anchor')=='middle': x-=width/2
                    if el.get('text-anchor')=='end': x-=width
                    a={k:v for k,v in el.attrib.items() if k not in ['x','y','font-size','font-weight','letter-spacing','text-anchor']}
                    a.update({'fill':el.get('fill',P['ink']),'aria-label':s,'data-text':s})
                    g=ET.Element(f'{{{NS}}}g',a)
                    for d,advance,u in gl:
                        if d: ET.SubElement(g,f'{{{NS}}}path',{'d':d,'transform':f'translate({x:.3f} {y:.3f}) scale({size/u:.6f} {-size/u:.6f})'})
                        x+=advance*size/u+spacing
                    parent.remove(el); parent.insert(i,g)
                else: visit(el)
        visit(root)
        return ET.tostring(root,encoding='unicode')

parser=argparse.ArgumentParser()
parser.add_argument('--font',default=str(next(Path('/System/Library/AssetsV2/com_apple_MobileAsset_Font8').rglob('PingFang.ttc'))))
parser.add_argument('--regular-index',type=int,default=3)
parser.add_argument('--bold-index',type=int,default=11)
parser.add_argument('--art-source',default=str(ROOT.parent/'sikeoop-eva-miku-v1/svg/theme-vector-layered.svg'))
args=parser.parse_args(); OUT=Outliner(args.font,args.regular_index,args.bold_index)
ASSETS=[]
def write(name,content):
    p=ROOT/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(content,encoding='utf-8')
def asset(name,body,w,h,label,category,outline=True):
    doc=svg(body,w,h,label)
    if outline: doc=OUT.convert(doc)
    write(name,doc); ASSETS.append(dict(file=name,width=w,height=h,label=label,category=category))
    return doc

# Reuse the already editable native-vector character design, not the raster trace.
source=ROOT/'source/theme-vector-layered.svg'
if not source.exists():
    source.parent.mkdir(parents=True,exist_ok=True)
    source.write_bytes(Path(args.art_source).read_bytes())
hero_root=ET.parse(source).getroot()
hero_defs=''.join(ET.tostring(el,encoding='unicode') for el in hero_root.find(f'{{{NS}}}defs'))
def namespace_ids(s,prefix):
    ids=re.findall(r'\bid="([^"]+)"',s)
    for i in sorted(ids,key=len,reverse=True):
        s=s.replace(f'id="{i}"',f'id="{prefix}{i}"').replace(f'url(#{i})',f'url(#{prefix}{i})').replace(f'href="#{i}"',f'href="#{prefix}{i}"')
    return s
hero_ids=[el.get('id') for el in hero_root.iter() if el.get('id')]
def prefix_hero(s):
    for i in sorted(hero_ids,key=len,reverse=True):
        s=s.replace(f'id="{i}"',f'id="hero-{i}"').replace(f'url(#{i})',f'url(#hero-{i})')
    return s
DEFS+=prefix_hero(hero_defs)
ART={el.get('id'):prefix_hero(ET.tostring(el,encoding='unicode')) for el in hero_root if el.tag==f'{{{NS}}}g'}
def positioned_art(names): return group(group(''.join(ART[n] for n in names),transform='translate(-698 47) scale(.55)'),clip_path='url(#sidebar-clip)')

ICONS={
 'close':['M6 6l12 12M18 6 6 18'], 'minimize':['M5 12h14'],
 'next':['M5 12h14m-6-6 6 6-6 6'], 'back':['M19 12H5m6-6-6 6 6 6'],
 'check':['m4 12 5 5L20 6'], 'folder':['M3 7V4h6l2 3h10v13H3Z'],
 'terminal':['m5 7 5 5-5 5M13 17h6'], 'workspace':['M3 4h18v16H3ZM3 8h18M8 8v12'],
 'sparkle':['M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3Z'],
 'shield':['M12 2 21 6v7l-3 5-6 4-6-4-3-5V6Z','m7 12 4 4 6-7'],
 'install':['M3 7h18v14H3ZM3 7l4-4h10l4 4M12 10v7m-4-4 4 4 4-4'],
 'play':['M8 4l12 8-12 8Z'], 'warning':['M12 3 22 21H2Z','M12 9v6M12 18h.01'],
 'document':['M5 3h10l5 5v13H5ZM15 3v5h5M8 12h8M8 16h6'],
 'chevron-down':['m6 9 6 6 6-6'], 'retry':['M21 8A9 9 0 0 0 5 5L3 8M3 16a9 9 0 0 0 16 3l2-3','M3 3v5h5M21 21v-5h-5'],
 'user':['M12 2a4 4 0 1 0 0 8 4 4 0 1 0 0-8ZM4 22v-3a8 8 0 0 1 16 0v3'],
 'users':['M9 3a4 4 0 1 0 0 8 4 4 0 1 0 0-8ZM2 22v-3a7 7 0 0 1 14 0v3M17 3a4 4 0 0 1 0 8M18 14a7 7 0 0 1 4 5v3'],
}
def icon(n,x=0,y=0,size=24,c=None): return group(''.join(path(d) for d in ICONS[n]),transform=f'translate({x} {y}) scale({size/24})',fill='none',stroke=c or P['aqua'],stroke_width=1.65,stroke_linecap='round',stroke_linejoin='round')
for n in ICONS: asset('icons/'+n+'.svg',icon(n),24,24,n,'icons')
crystal=path('M16 0 22 10 32 16 22 22 16 32 10 22 0 16 10 10Z',fill=P['violet'])+path('M16 0v32M0 16h32',stroke='#151422',stroke_width=1.3)+path('M10 10 22 22M22 10 10 22',stroke=P['pink'],stroke_width=.8)
asset('icons/sikeoop-crystal.svg',crystal,32,32,'同步晶体标','icons')
symbol_docs=[]
for n in ICONS: symbol_docs.append(f'<symbol id="icon-{n}" viewBox="0 0 24 24">{icon(n,c="currentColor")}</symbol>')
write('icons/sprite.svg',svg(''.join(symbol_docs),24,24,'Installer icon sprite',defs=''))

def button(label,w=172,kind='primary',ico=None,state='normal',name=None):
    fill='url(#button-gradient)' if kind=='primary' else P['raised'] if kind=='secondary' else 'none'
    color='#101B24' if kind=='primary' else P['ink']
    stroke='none' if kind=='primary' else P['line']
    if state=='hover': fill='#8CF4F1' if kind=='primary' else '#2A273E'
    if state=='pressed': fill='#32BDCD' if kind=='primary' else '#151422'
    if state=='disabled': fill='#333448'; color=P['faint']
    body=rect(1,1,w-2,44,fill,8,stroke=stroke,stroke_width=1)
    shift=13 if ico else 0
    body+=text(w/2-shift,29,label,15,color,600,0,'middle')
    if ico: body+=icon(ico,w-39,13,20,color)
    return action(name,body,label) if name else body
for kind,w in [('primary',172),('secondary',112)]:
    for state in ['normal','hover','pressed','disabled']:
        asset(f'components/button-{kind}-{state}.svg',button('开始安装' if kind=='primary' else '取消',w,kind,'next' if kind=='primary' else None,state),w,46,f'{kind} / {state}','components')
asset('components/button-primary-label-free.svg',rect(1,1,170,44,'url(#button-gradient)',8),172,46,'主按钮空白底板','components')
def checkbox(on=True): return rect(1,1,18,18,P['aqua'] if on else P['surface'],4,stroke=P['aqua'] if on else P['faint'],stroke_width=1)+(icon('check',2,2,16,'#0E1923') if on else '')
def radio(on=True): return circle(10,10,9,fill=P['surface'],stroke=P['aqua'] if on else P['faint'],stroke_width=1.4)+(circle(10,10,4,fill=P['aqua']) if on else '')
for on in [False,True]:
    asset('components/checkbox-'+('on' if on else 'off')+'.svg',checkbox(on),20,20,'复选框','components')
    asset('components/radio-'+('on' if on else 'off')+'.svg',radio(on),20,20,'单选框','components')
asset('components/input-install-directory.svg',rect(1,1,566,44,P['bg'],7,stroke=P['line'],stroke_width=1)+icon('folder',14,13,20),568,46,'安装目录输入框底板','components')
asset('components/progress-track.svg',rect(0,0,568,8,'#2E2B40',4),568,8,'安装进度底轨','components')
asset('components/progress-64.svg',rect(0,0,568,8,'#2E2B40',4)+rect(0,0,568*.64,8,'url(#progress-gradient)',4),568,8,'64% 安装进度','components')
asset('components/status-success.svg',circle(32,32,30,fill='#1A2A2A',stroke=P['aqua'],stroke_width=1)+icon('check',14,14,36),64,64,'成功状态标','components')
asset('components/status-warning.svg',circle(32,32,30,fill='#30202B',stroke=P['error'],stroke_width=1)+icon('warning',14,14,36,P['error']),64,64,'失败状态标','components')
asset('frames/window-surface.svg',rect(1,1,1038,658,'url(#shell-gradient)',14,stroke=P['line'],stroke_width=1),W,H,'安装器窗体底板','frames')
asset('frames/sidebar.svg',rect(0,0,364,660,'url(#sidebar-gradient)',14),364,660,'品牌侧栏底板','frames')

LEFT_ART=[('hero-eva','EVA 初号机', ['eva-silhouette','eva-armor','eva-lights']),
          ('hero-hair-back','初音后发', ['miku-hair-back']),('hero-suit','初音驾驶服',['miku-pilot-suit']),
          ('hero-face','初音面部',['miku-face']),('hero-front-hair','初音前发',['miku-front-hair']),
          ('hero-headset','耳机与轮廓光',['miku-headset','rim-lights'])]
art_all=''.join(positioned_art(ns) for _,_,ns in LEFT_ART)
asset('illustrations/eva-miku-sidebar.svg',art_all,364,660,'EVA × Miku 安装器侧栏插画','illustrations')
for i,label,ns in LEFT_ART: asset('illustrations/parts/'+i+'.svg',positioned_art(ns),364,660,label,'illustration-parts')

def hexagon(cx,cy,r): return 'M'+' '.join(f'{cx+r*math.cos(i*math.pi/3):.2f},{cy+r*math.sin(i*math.pi/3):.2f}' for i in range(6))+'Z'
at=circle(186,277,272,fill='url(#sidebar-aura)')+''.join(path(hexagon(182,288,r),fill='none',stroke=P['aqua'] if j%2==0 else P['violet'],stroke_width=.8,opacity=.18) for j,r in enumerate([152,165,178,241,255]))
asset('decorations/at-field.svg',at,364,660,'AT 立场六边环','decorations')
hazard=''.join(path(f'M{x+5} 0h9l-5 8H{x}Z',fill=P['lime']) for x in range(0,88,16))
asset('decorations/hazard-stripes.svg',hazard,100,8,'初号机绿色警戒条','decorations')
asset('decorations/sync-corner.svg',path('M0 32V0h32M6 23V6h17',fill='none',stroke=P['aqua'],stroke_width=1.4),34,34,'同步角标','decorations')

STATES={'welcome':dict(label='欢迎',step=0,eyebrow='01 / WELCOME',title='安装 sikeoop',subtitle='让想法、代码与 AI，在这里同步。'),
        'options':dict(label='安装选项',step=1,eyebrow='02 / CONFIGURATION',title='选择安装选项',subtitle='选择安装位置与启动方式。'),
        'installing':dict(label='安装中',step=2,eyebrow='03 / SYNCHRONIZING',title='正在安装',subtitle='正在部署工作区组件，请稍候。'),
        'finish':dict(label='安装完成',step=3,eyebrow='04 / READY',title='安装完成',subtitle='你的 AI 工作空间，已准备就绪。'),
        'error':dict(label='安装失败',step=2,eyebrow='03 / ATTENTION',title='安装未完成',subtitle='此安装位置没有足够的可用空间。'),
        'cancel':dict(label='取消确认',step=2,eyebrow='03 / SYNCHRONIZING',title='正在安装',subtitle='正在部署工作区组件，请稍候。')}
DEFAULT_PATH='%LOCALAPPDATA%\\Programs\\sikeoop'
LAYERS=[]; EDITABLE={}
def common_layers(state):
    layers=[layer('window-surface','01 · 窗体底板',rect(1,1,1038,658,'url(#shell-gradient)',14))]
    layers.append(layer('sidebar-surface','02 · 深紫品牌侧栏',group(rect(0,0,364,660,'url(#sidebar-gradient)'),clip_path='url(#shell-clip)')))
    layers.append(layer('sidebar-at-field','03 · AT 立场背景',group(at,clip_path='url(#sidebar-clip)')))
    for j,(i,l,ns) in enumerate(LEFT_ART,4): layers.append(layer(i,f'{j:02d} · {l}',positioned_art(ns)))
    shade=rect(1,380,363,279,'url(#sidebar-fade)')+rect(1,1,363,74,'#161323',opacity=.81)
    layers.append(layer('sidebar-overlay','10 · 插画底部渐隐',group(shade,clip_path='url(#sidebar-clip)')))
    brand=group(crystal,transform='translate(30 22)')+text(76,46,'sikeoop',25,P['ink'],600)
    brand+=text(31,96,'EVA × MIKU / EDITION 01',10,P['aqua'],500,1.5)
    brand+=text(30,548,'同步，开始。',30,P['ink'],600)+text(31,579,'你的 AI 工作空间，即刻上线。',14,P['muted'])
    brand+=group(hazard,transform='translate(31 608)')+text(132,616,'UNIT 01 / SIGNAL 39',10,P['muted'],500,.8)
    brand+=path('M30 137v-17h22M333 492v19h-20',fill='none',stroke=P['aqua'],stroke_width=1,opacity=.55)
    layers.append(layer('sidebar-branding','11 · 品牌与主题文字',brand))
    titlebar=text(418,35,'WINDOWS SETUP',10,P['muted'],500,1.8)+text(914,35,'64-bit',10,P['faint'],400,0,'end')
    titlebar+=action('minimize',rect(938,10,40,34,'#151620',6)+icon('minimize',950,19,16,P['muted']),'最小化预览')
    titlebar+=action('close',rect(984,10,40,34,'#151620',6)+icon('close',996,19,16,P['muted']),'关闭')
    layers.append(layer('titlebar','12 · Windows 标题栏与窗口控件',titlebar))
    step=STATES[state]['step']; stages=['欢迎','选项','安装','完成']; b=''
    for j,l in enumerate(stages):
        x=428+j*151; active=j==step; done=j<step
        if j<3: b+=line(x+25,85,x+134,85,stroke=P['aqua'] if done else P['line'],stroke_width=1)
        b+=circle(x,85,10,fill='#263D3F' if active or done else P['surface'],stroke=P['aqua'] if active or done else '#55516B',stroke_width=1)
        b+=icon('check',x-7,78,14,P['aqua']) if done else text(x,89,str(j+1),10,P['aqua'] if active else P['muted'],600,0,'middle')
        b+=text(x+20,90,l,13,P['aqua'] if active else P['muted'],600 if active else 400)
    layers.append(layer('step-navigation','13 · 安装流程导航',b))
    return layers

def heading(s):
    c=P['error'] if s['eyebrow'].endswith('ATTENTION') else P['violet']
    return text(418,139,s['eyebrow'],10,c,500,1.5)+text(418,185,s['title'],34,P['ink'],600)+text(418,219,s['subtitle'],15,P['muted'])
def option_checkbox(y,label,name,on=True,sub=None):
    b=group(checkbox(on),transform=f'translate(419 {y})',id=name+'-mark')+text(451,y+16,label,15)
    if sub: b+=text(451,y+38,sub,12,P['muted'])
    return action(name,rect(416,y-3,572,47 if sub else 30,'#FFFFFF',opacity='0')+b,label)
def scope_card(x,selected,label,sub,ico,name):
    b=rect(x,332,277,69,'#1A242B' if selected else P['surface'],8,stroke=P['aqua'] if selected else P['line'],stroke_width=1,id=name+'-surface')
    b+=group(radio(selected),transform=f'translate({x+14} 346)',id=name+'-radio')+text(x+47,360,label,14,P['ink'],600)+text(x+47,383,sub,11,P['muted'])
    b+=icon(ico,x+239,347,22,P['aqua'] if selected else P['muted'])
    return action(name,b,label)
def progress_content():
    b=rect(418,250,568,96,P['raised'],10,stroke=P['line'],stroke_width=1)
    b+=text(438,277,'部署应用文件',14,P['ink'],600,id='stage-state')+text(965,283,'64%',24,P['aqua'],600,0,'end',id='progress-percent')
    b+=rect(438,308,528,8,'#302C44',4)+rect(438,308,528*.64,8,'url(#progress-gradient)',4,id='progress-fill')
    rows=[('校验安装包','已完成','shield'),('部署应用文件','进行中','install'),('创建快捷方式','等待中','workspace'),('完成配置','等待中','check')]
    for j,(l,status,ic) in enumerate(rows):
        y=380+j*42; c=P['aqua'] if j<2 else P['faint']
        b+=icon('check' if j==0 else ic,426,y-16,20,c)+text(461,y,l,14,P['ink'] if j<2 else P['muted'])
        b+=text(974,y,status,12,c,400,0,'end')
        if j<3:b+=line(436,y+4,436,y+22,stroke=P['line'],stroke_width=1)
    b+=action('show-log',rect(418,537,568,30,'#FFFFFF',opacity='0')+icon('document',421,540,18,P['muted'])+text(449,555,'查看安装日志',12,P['muted'])+icon('chevron-down',966,540,18,P['muted']),'查看安装日志')
    return b

def compose(state):
    layers=common_layers(state); s=STATES[state]; body=heading(s)
    footer=line(418,577,986,577,stroke=P['line'],stroke_width=1)
    if state=='welcome':
        features=[('sparkle','AI 与代码协作','从一个想法，到可运行的作品。'),('workspace','统一工作空间','文件、会话与项目，保持同步。'),('terminal','终端与工具集成','熟悉的开发流程，更少的切换。')]
        body+=rect(418,260,568,228,P['raised'],10,stroke=P['line'],stroke_width=1)
        for j,(ico,title,sub) in enumerate(features):
            y=284+72*j
            body+=rect(438,y,40,40,'#28223B',9)+icon(ico,447,y+9,22)
            body+=text(493,y+15,title,16,P['ink'],600)+text(493,y+38,sub,13,P['muted'])
            if j<2:body+=line(493,y+58,965,y+58,stroke=P['line'],stroke_width=.7)
        body+=icon('user',419,514,20,P['muted'])+text(449,530,'默认仅为当前用户安装',13,P['muted'])
        body+=text(449,551,'可在下一步修改安装目录与快捷方式。',12,P['faint'])
        footer+=text(419,613,'EVA × MIKU / SIKEOOP',10,P['faint'],500,.6)+group(button('取消',112,'secondary',name='close'),transform='translate(688 591)')+group(button('开始安装',172,'primary','next',name='next'),transform='translate(814 591)')
    elif state=='options':
        body+=text(418,254,'安装目录',13,P['ink'],600)
        body+=rect(418,266,568,44,P['bg'],7,stroke=P['line'],stroke_width=1)+icon('folder',432,278,20)
        body+=text(465,293,DEFAULT_PATH,12,P['muted'],id='install-path-text')
        body+=action('browse',rect(915,273,63,30,P['raised'],5)+text(946,293,'浏览',12,P['ink'],500,0,'middle'),'浏览目录')
        body+=scope_card(418,True,'当前用户','无需额外管理员权限','user','scope-user')+scope_card(709,False,'所有用户','安装时可能需要管理员权限','users','scope-machine')
        body+=option_checkbox(424,'创建桌面快捷方式','desktop-shortcut',True)
        body+=option_checkbox(463,'登录 Windows 时启动','startup',False,'默认关闭，可稍后在设置中启用。')
        body+=line(418,527,986,527,stroke=P['line'],stroke_width=1)+icon('shield',420,541,18,P['aqua'])+text(449,554,'安装前检查目标目录权限与可用空间。',12,P['muted'])
        footer+=group(button('上一步',112,'secondary',name='back'),transform='translate(418 591)')+group(button('取消',112,'secondary',name='close'),transform='translate(688 591)')+group(button('确认安装',172,'primary','next',name='install'),transform='translate(814 591)')
    elif state in ['installing','cancel']:
        body+=progress_content()
        footer+=text(419,618,'正在安装，请保持此窗口打开。',12,P['muted'])+group(button('取消安装',112,'secondary',name='cancel-install'),transform='translate(874 591)')
    elif state=='finish':
        body=text(418,139,s['eyebrow'],10,P['aqua'],500,1.5)
        body+=circle(702,241,48,fill='#172F32',stroke='#376266',stroke_width=1)+circle(702,241,38,fill='none',stroke=P['aqua'],stroke_width=1)+icon('check',678,217,48)
        body+=text(702,337,'安装完成',34,P['ink'],600,0,'middle')+text(702,374,s['subtitle'],16,P['muted'],400,0,'middle')
        body+=rect(418,412,568,66,P['raised'],8,stroke=P['line'],stroke_width=1)+icon('folder',435,434,22)+text(470,434,'安装位置',11,P['muted'])+text(470,457,DEFAULT_PATH,13,P['ink'],id='finish-path-text')
        body+=option_checkbox(504,'完成后启动 sikeoop','launch-app',True)
        footer+=text(419,618,'SYNCHRONIZATION COMPLETE',10,P['aqua'],500,1)+group(button('完成并启动',172,'primary','play',name='launch'),transform='translate(814 591)')
    elif state=='error':
        body+=rect(418,250,568,123,'#261C29',10,stroke='#67404F',stroke_width=1)+icon('warning',438,274,30,P['error'])
        body+=text(486,281,'磁盘空间不足',17,P['error'],600)+text(486,311,'请更换安装目录，或释放磁盘空间后重试。',13,P['muted'])+text(486,346,'ERROR / DISK_SPACE',10,P['error'],500,1)
        body+=text(418,411,'当前安装位置',13,P['muted'])+rect(418,428,568,46,P['bg'],7,stroke=P['line'],stroke_width=1)+icon('folder',432,441,20)+text(465,457,DEFAULT_PATH,12,P['muted'])
        body+=action('show-log',rect(417,500,570,40,'#FFFFFF',opacity='0')+icon('document',420,511,20,P['muted'])+text(450,527,'查看错误日志',13,P['muted'])+icon('next',966,511,20,P['muted']),'查看错误日志')
        footer+=group(button('更改目录',112,'secondary',name='change-directory'),transform='translate(418 591)')+group(button('取消',112,'secondary',name='close'),transform='translate(688 591)')+group(button('重试安装',172,'primary','retry',name='retry'),transform='translate(814 591)')
    layers.append(layer('screen-content','14 · 页面内容与状态',body))
    layers.append(layer('footer-actions','15 · 底部操作区',footer))
    outline=rect(1,1,1038,658,'none',14,stroke='#565065',stroke_width=1)+line(364,1,364,659,stroke=P['line'],stroke_width=1)+path('M18 1h104M1 18v61',fill='none',stroke=P['aqua'],stroke_width=1.8)+path('M1022 659h-72',stroke=P['violet'],stroke_width=1.8)
    layers.append(layer('window-outline','16 · 外框与主题细节',outline))
    if state=='cancel':
        modal=rect(1,1,1038,658,'#05060D',14,opacity=.72)+rect(290,220,460,228,P['surface'],12,stroke='#6B597D',stroke_width=1)
        modal+=icon('warning',322,247,26,P['pink'])+text(364,267,'要取消安装吗？',23,P['ink'],600)
        modal+=text(322,311,'取消后将回滚本次新增的安装文件。',14,P['muted'])+text(322,338,'已有项目与个人设置应保留。',13,P['muted'])
        modal+=group(button('继续安装',172,'primary',name='resume'),transform='translate(322 378)')+group(button('取消并退出',172,'secondary',name='confirm-cancel'),transform='translate(522 378)')
        layers.append(layer('cancel-dialog','17 · 取消与回滚确认弹窗',modal))
    return layers

for state,s in STATES.items():
    layers=compose(state); body=''.join(layers)
    editable=svg(body,W,H,'sikeoop Windows 安装器 / '+s['label']); EDITABLE[state]=editable
    asset('screens/installer-'+state+'.svg',body,W,H,s['label'],'screens')
    asset('editable/installer-'+state+'.svg',body,W,H,s['label']+' / 可编辑文字','editable',False)
    if state=='welcome':
        parsed=[ET.fromstring(svg(l,W,H,'Layer')).find(f'{{{NS}}}g') for l in layers]
        LAYERS=[dict(id=l.get('id'),label=l.get(f'{{{INK}}}label'),file='layers/'+l.get('id')+'.svg') for l in parsed]
        asset('installer-layered.svg',body,W,H,'Windows 安装器欢迎页 / 分层母版','master')
        for item,l in zip(LAYERS,layers):asset(item['file'],l,W,H,item['label'],'layers')

showcase=rect(0,0,1440,980,P['bg'])+circle(342,311,490,fill='url(#sidebar-aura)')
showcase+=path('M0 793h187l52-52h113M1379 160h61M1330 810h110',fill='none',stroke=P['line'],stroke_width=1)
showcase+=text(92,91,'sikeoop / WINDOWS SETUP',26,P['ink'],600)+text(92,123,'EVA × MIKU — 安装，也是一场同步。',15,P['muted'])
showcase+=rect(196,184,1048,668,'#000000',20,opacity=.36)
showcase+=group(''.join(compose('welcome')),transform='translate(200 180)')
showcase+=text(92,926,'DEDICATED INSTALLER UI',11,P['aqua'],500,1.7)+text(1348,926,'1040 × 660 / NATIVE VECTOR',11,P['muted'],400,1,'end')
asset('previews/installer-effect.svg',showcase,1440,980,'Windows 安装器效果图','previews')

board=rect(0,0,1536,1160,P['bg'])+text(56,69,'sikeoop / WINDOWS INSTALLER',29,P['ink'],600)+text(56,102,'EVA × MIKU · 四步安装流程 · 纯矢量界面设计',15,P['muted'])
for j,state in enumerate(['welcome','options','installing','finish']):
    x=56+(j%2)*736; y=145+(j//2)*478
    board+=text(x,y+18,f'0{j+1} / '+STATES[state]['label'],15,P['aqua'],600)
    # Nested SVG namespaces isolate every ID for sheet imports and rendering.
    nested=namespace_ids(svg(''.join(compose(state)),W,H,STATES[state]['label']),f'sheet-{state}-')
    nested=nested.replace(f'width="{W}" height="{H}"',f'x="{x}" y="{y+38}" width="688" height="437"',1)
    board+=nested
asset('previews/installer-flow-overview.svg',board,1536,1160,'四步安装流程总览','previews')

components=rect(0,0,1200,720,P['bg'])+text(42,63,'INSTALLER / UI COMPONENTS',26,P['ink'],600)
for j,n in enumerate(ICONS):
    x=45+(j%9)*129; y=121+(j//9)*101
    components+=rect(x,y,88,70,P['raised'],9,stroke=P['line'],stroke_width=1)+icon(n,x+32,y+21,25)
    components+=text(x+44,y+92,n,10,P['muted'],400,0,'middle')
components+=text(44,365,'ACTIONS',12,P['violet'],500,1.2)
for j,st in enumerate(['normal','hover','pressed','disabled']):
    x=44+j*281;components+=group(button('开始安装',172,'primary','next',st),transform=f'translate({x} 388)')+text(x,461,st,12,P['muted'])
components+=text(44,522,'SELECTION & PROGRESS',12,P['violet'],500,1.2)
components+=group(checkbox(True),transform='translate(45 548)')+group(checkbox(False),transform='translate(99 548)')+group(radio(True),transform='translate(153 548)')+group(radio(False),transform='translate(207 548)')
components+=rect(288,555,650,8,'#302C44',4)+rect(288,555,416,8,'url(#progress-gradient)',4)+text(975,565,'64%',16,P['aqua'],600)
components+=text(44,651,'AQUA / ACTION',12,P['aqua'],500,1)+text(301,651,'VIOLET / IDENTITY',12,P['violet'],500,1)+text(590,651,'LIME / SYNCHRONIZATION',12,P['lime'],500,1)+text(938,651,'PINK / ATTENTION',12,P['error'],500,1)
asset('previews/components-overview.svg',components,1200,720,'安装器组件总览','previews')

write('tokens.json',json.dumps(dict(theme='EVA × Hatsune Miku / Windows installer',canvas=dict(width=W,height=H,sidebarWidth=SIDEBAR),colors=P,typography=dict(primary='Segoe UI',cjk='Microsoft YaHei UI',outlineSource='PingFang SC',heading=34,body=15,caption=12),geometry=dict(contentX=418,contentWidth=568,footerY=577,buttonHeight=46,cornerRadius=14),defaults=dict(scope='currentUser',installPath=DEFAULT_PATH,desktopShortcut=True,startWithWindows=False,launchAfterInstall=True),stateKeys=list(STATES),status='design-only-not-integrated'),ensure_ascii=False,indent=2)+'\n')
write('assets.json',json.dumps(dict(assets=ASSETS,layers=LAYERS,states=STATES,sourceArtwork='source/theme-vector-layered.svg',status='native-vector-design-not-installer-executable'),ensure_ascii=False,indent=2)+'\n')
write('prototype-screens.json',json.dumps(EDITABLE,ensure_ascii=False)+'\n')
print(json.dumps(dict(svgAssets=len(ASSETS),screens=len(STATES),layers=len(LAYERS),icons=len(ICONS)+1),ensure_ascii=False))
