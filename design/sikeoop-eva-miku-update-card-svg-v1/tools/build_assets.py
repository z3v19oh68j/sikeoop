#!/usr/bin/env python3
"""Build editable native-vector update-card assets. Never edits the application."""
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
P = dict(bg='#0B0C14', panel='#141122', raised='#1D1930', line='#382E50',
         violet='#9B7BFF', cyan='#5CE1E6', lime='#C5F66F', pink='#FF71B8',
         orange='#FFB05C', ink='#F0EEF8', muted='#A6A0B8', bad='#FF7C95')
DEFS = '''<linearGradient id="surface" x2="1" y2="1"><stop stop-color="#10101B"/><stop offset=".54" stop-color="#141122"/><stop offset="1" stop-color="#18132A"/></linearGradient>
<linearGradient id="purpleBorder" x2=".8" y2="1"><stop stop-color="#8B66D5"/><stop offset=".48" stop-color="#493068"/><stop offset="1" stop-color="#9B7BFF"/></linearGradient>
<linearGradient id="primary" x2="1" y2="1"><stop stop-color="#62E8EA"/><stop offset="1" stop-color="#34DCE5"/></linearGradient>
<linearGradient id="artFade"><stop stop-color="#11101D"/><stop offset="1" stop-color="#11101D" stop-opacity="0"/></linearGradient>
<clipPath id="cardClip"><path d="M28 1H1330L1359 29V883L1330 911H28L1 883V29Z"/></clipPath>
<clipPath id="heroClip"><rect x="552" y="60" width="806" height="314"/></clipPath>'''
FONT_FAMILY = 'PingFang SC, Heiti SC, STHeiti, Microsoft YaHei, sans-serif'

def attr(**a): return ' '.join(f'{k.replace("_", "-")}="{html.escape(str(v),quote=True)}"' for k,v in a.items())
def path(d, **a): return f'<path d="{d}" {attr(**a)}/>'
def rect(x,y,w,h,fill,rx=0,**a): return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" {attr(**a)}/>'
def circle(x,y,r,**a): return f'<circle cx="{x}" cy="{y}" r="{r}" {attr(**a)}/>'
def line(x1,y1,x2,y2,**a): return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" {attr(**a)}/>'
def group(body,**a): return f'<g {attr(**a)}>{body}</g>'
def text(x,y,s,size=22,color=None,weight=400,spacing=0,anchor=None):
    a=dict(x=x,y=y,font_size=size,fill=color or P['ink'],font_weight=weight,letter_spacing=spacing)
    if anchor: a['text_anchor']=anchor
    return f'<text {attr(**a)}>{html.escape(s)}</text>'
def panel(x,y,w,h,c=16,fill='url(#surface)',stroke=None):
    return path(f'M{x+c} {y}H{x+w-c}L{x+w} {y+c}V{y+h-c}L{x+w-c} {y+h}H{x+c}L{x} {y+h-c}V{y+c}Z',fill=fill,**({'stroke':stroke,'stroke_width':1.1} if stroke else {}))
def layer(name,label,body):
    return f'<g id="{name}" inkscape:groupmode="layer" inkscape:label="{html.escape(label)}">{body}</g>'
def svg(body,w,h,title,defs=DEFS):
    return f'<svg xmlns="{NS}" xmlns:inkscape="{INK}" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONT_FAMILY}"><title>{html.escape(title)}</title><desc>Native SVG paths and shapes. No embedded raster, no external images.</desc><defs>{defs}</defs>{body}</svg>'

class Outliner:
    def __init__(self, regular, bold,regular_index,bold_index):
        self.fonts=[TTFont(regular,fontNumber=regular_index),TTFont(bold,fontNumber=bold_index)]
        self.cache={}
    def glyph(self,char,bold):
        key=(char,bold)
        if key not in self.cache:
            f=self.fonts[bold]; cmap=f.getBestCmap(); name=cmap.get(ord(char))
            if name is None: raise ValueError(f'Missing glyph: {char!r}')
            pen=SVGPathPen(f.getGlyphSet());f.getGlyphSet()[name].draw(pen)
            self.cache[key]=(pen.getCommands(),f['hmtx'][name][0],f['head'].unitsPerEm)
        return self.cache[key]
    def convert(self, content):
        root=ET.fromstring(content)
        def visit(parent):
            for i,el in enumerate(list(parent)):
                if el.tag==f'{{{NS}}}text':
                    s=''.join(el.itertext()); size=float(el.get('font-size','22'))
                    bold=1 if float(el.get('font-weight','400'))>=550 else 0
                    spacing=float(el.get('letter-spacing','0'))
                    glyphs=[self.glyph(c,bold) for c in s]
                    width=sum(a*size/u for _,a,u in glyphs)+max(0,len(s)-1)*spacing
                    x=float(el.get('x','0'));y=float(el.get('y','0'))
                    if el.get('text-anchor')=='middle': x-=width/2
                    if el.get('text-anchor')=='end': x-=width
                    g=ET.Element(f'{{{NS}}}g',{'fill':el.get('fill',P['ink']),'aria-label':s,'data-text':s})
                    if el.get('id'):g.set('id',el.get('id'))
                    for d,advance,u in glyphs:
                        if d:
                            scale=size/u
                            ET.SubElement(g,f'{{{NS}}}path',{'d':d,'transform':f'translate({x:.3f} {y:.3f}) scale({scale:.6f} {-scale:.6f})'})
                        x+=advance*size/u+spacing
                    parent.remove(el);parent.insert(i,g)
                else: visit(el)
        visit(root)
        return ET.tostring(root,encoding='unicode')

parser=argparse.ArgumentParser()
pingfang=next(Path('/System/Library/AssetsV2/com_apple_MobileAsset_Font8').rglob('PingFang.ttc'),None)
parser.add_argument('--font-regular',default=str(pingfang) if pingfang else '/System/Library/Fonts/STHeiti Light.ttc')
parser.add_argument('--font-bold',default=str(pingfang) if pingfang else '/System/Library/Fonts/STHeiti Medium.ttc')
parser.add_argument('--regular-index',type=int,default=3 if pingfang else 1)
parser.add_argument('--bold-index',type=int,default=11 if pingfang else 1)
args=parser.parse_args()
OUTLINER=Outliner(args.font_regular,args.font_bold,args.regular_index,args.bold_index)
ASSETS=[]
def write(name,content):
    p=ROOT/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content,encoding='utf-8')
def asset(name,body,w,h,label,category,outlined=True,defs=DEFS):
    content=svg(body,w,h,label,defs)
    if outlined: content=OUTLINER.convert(content)
    write(name,content)
    ASSETS.append(dict(file=name,width=w,height=h,label=label,category=category))
    return content

# Twenty small glyphs required by update, download, verify and restart states.
ICONS={
'close': ['M6 6l12 12M18 6 6 18'],
'folder':['M3 7V4h6l2 3h10v13H3Z'],
'ai-network':['M8.6 7.3 10 10M14 10l1.5-2.7M10 14l-1.7 2.8M14 14l1.6 2.6M6 8v8M18 8v8M9 5h6M9 19h6','M6 2a3 3 0 1 0 0 6 3 3 0 1 0 0-6ZM18 2a3 3 0 1 0 0 6 3 3 0 1 0 0-6ZM6 16a3 3 0 1 0 0 6 3 3 0 1 0 0-6ZM18 16a3 3 0 1 0 0 6 3 3 0 1 0 0-6ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5Z'],
'wrench':['M14 3a6 6 0 0 0-7 7L2 16v5h5l6-7a6 6 0 0 0 8-8l-5 5-3-3 4-5Z'],
'download':['M12 3v12M7 10l5 5 5-5M3 15v6h18v-6'],
'restart':['M21 8A9 9 0 0 0 5 5L3 8M3 16a9 9 0 0 0 16 3l2-3','M3 3v5h5M21 21v-5h-5'],
'pause':['M7 4v16M17 4v16'],
'chevron-right':['m9 5 7 7-7 7'],
'check':['m4 12 5 5L20 6'],
'shield-check':['M12 2 21 7v7l-3 5-6 4-6-4-3-5V7Z','m7 12 4 4 6-7'],
'warning':['M12 3 22 21H2Z','M12 9v6M12 18h.01'],
'error':['M7 3h10l4 4v10l-4 4H7l-4-4V7Z','m8 8 8 8M16 8l-8 8'],
'clock':['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z','M12 7v5l4 3'],
'check-circle':['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z','m7 12 3 3 7-7'],
'spinner':['M12 3a9 9 0 1 1-9 9'],
'info':['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z','M12 11v6M12 7h.01'],
'release-notes':['M5 3h10l5 5v13H5Z','M15 3v5h5M8 12h8M8 16h6'],
'external-link':['M14 3h7v7M21 3 10 14M10 5H3v16h16v-7'],
'activity':['M2 12h5l3-8 4 16 3-8h5'],
'install':['M3 6h18v15H3ZM3 6l4-3h10l4 3M12 9v8M8 13l4 4 4-4'],
}
def icon(name,x=0,y=0,size=24,color=None):
    return group(''.join(path(d) for d in ICONS[name]),transform=f'translate({x} {y}) scale({size/24})',fill='none',stroke=color or P['cyan'],stroke_width=1.65,stroke_linecap='round',stroke_linejoin='round')
for n in ICONS: asset('icons/'+n+'.svg',icon(n),24,24,n,'icons')
logo=path('M20 0 27 13 40 20 27 27 20 40 13 27 0 20 13 13Z',fill=P['violet'])+path('M20 0v40M0 20h40',stroke='#171020',stroke_width=1.5)+path('M13 13 27 27M27 13 13 27',stroke=P['pink'],stroke_width=.7)
asset('icons/sikeoop-crystal.svg',logo,40,40,'sikeoop 同步晶体标','icons')
asset('typography/wordmark.svg',text(0,31,'sikeoop',32,P['ink'],600),150,44,'sikeoop 字标','typography')

art_file=ROOT/'illustrations/hero-eva-miku-paths.svg'
art_root=ET.parse(art_file).getroot()
ART=''.join(ET.tostring(el,encoding='unicode') for el in art_root if el.tag.endswith('path') or el.tag.endswith('g'))
assert ART and '<image' not in ART
ASSETS.append(dict(file='illustrations/hero-eva-miku-paths.svg',width=796,height=314,label='初音 × EVA 原图路径矢量化横幅',category='illustrations'))

def hexagon(cx,cy,r):
    pts=[(cx+r*math.cos(i*math.pi/3),cy+r*math.sin(i*math.pi/3)) for i in range(6)]
    return 'M'+' '.join(f'{x:.2f},{y:.2f}' for x,y in pts)+'Z'
at=path(hexagon(88,88,83),fill='none',stroke=P['violet'],stroke_width=1.3)+path(hexagon(88,88,73),fill='none',stroke=P['violet'],stroke_width=.8,opacity=.55)+text(88,66,'EVA',13,P['violet'],500,2,'middle')+text(88,115,'01',48,P['violet'],400,0,'middle')+path('M66 136h9M82 136h9M98 136h9',stroke=P['violet'],stroke_width=3)
asset('decorations/at-field-01.svg',at,176,176,'AT 立场 / 01 标牌','decorations')
hazard=''.join(path(f'M{x+11} 0h12l-11 14H{x}Z',fill=P['orange']) for x in [0,20,40])
asset('decorations/hazard-notches.svg',hazard,64,14,'警戒橙短斜纹','decorations')
brackets=path('M0 19 18 1h260l18 18M8 23 26 5M300 5l18 18M306 5l18 18',fill='none',stroke=P['line'],stroke_width=1.3)+path('M8 23 26 5M300 5l18 18M306 5l18 18',fill='none',stroke=P['cyan'],stroke_width=2)
asset('decorations/header-sync-brackets.svg',brackets,330,30,'标题同步支架','decorations')
engineering=path('M18 26h116l27-27M21 214h218l31-30M945 13h262l39 38M916 236h245l82-81M515 95l63 63v62',fill='none',stroke=P['violet'],stroke_width=.8,opacity=.35)+''.join(circle(x,y,1.5,fill=P['violet'],opacity=.65) for x,y in [(36,44),(322,52),(735,100),(910,138),(1208,50),(1243,155),(514,95)])
asset('decorations/engineering-lines.svg',engineering,1280,252,'工程线与定位点','decorations')
asset('decorations/divider.svg',line(0,1,1240,1,stroke=P['line'],stroke_width=1),1240,2,'内容分隔线','decorations')
asset('decorations/title-stripes.svg',path('M0 0h14L6 8H-8ZM20 0h14L26 8H12ZM40 0h14L46 8H32ZM60 0h64l-8 8H52Z',fill=P['violet']),128,10,'标题条纹','decorations')

base=panel(1,1,1358,910,28,stroke=None)
border=panel(1,1,1358,910,28,fill='none',stroke='url(#purpleBorder)')+path('M1 26 26 1h1300',fill='none',stroke=P['cyan'],stroke_width=3)+path('M1359 881l-30 30',stroke=P['violet'],stroke_width=4)
header=path('M28 1h1302l29 28v29H1V29Z',fill='#11101F',stroke=P['line'],stroke_width=.8)
content=panel(22,374,1314,374,16,stroke=P['line'])
footer=panel(22,760,1314,112,16,stroke=P['line'])
list_surface=rect(56,438,1246,198,'#141222',10,stroke=P['line'],stroke_width=1)
for n,b,w,h,label in [('card-background',base,1360,912,'卡片底板'),('card-border',border,1360,912,'外框与青色顶边'),('header-surface',panel(0,0,1360,60,16,stroke=P['line']),1360,60,'标题栏底板'),('content-panel',panel(0,0,1314,374,16,stroke=P['line']),1314,374,'更新内容面板'),('footer-panel',panel(0,0,1314,112,16,stroke=P['line']),1314,112,'操作区面板'),('feature-list-panel',rect(0,0,1246,198,'#141222',10,stroke=P['line'],stroke_width=1),1246,198,'更新列表底板')]:
    asset('frames/'+n+'.svg',b,w,h,label,'frames')

def toggle(on=True,disabled=False):
    fill='#514963' if disabled else 'url(#primary)' if on else '#332E46'
    return rect(1,1,70,34,fill,17,stroke='#615672' if not on or disabled else P['cyan'],stroke_width=1)+circle(53 if on else 19,18,13,fill='#A6A0B8' if disabled else '#F0FFFF')
for n,on,dis in [('toggle-on',True,False),('toggle-off',False,False),('toggle-disabled',True,True)]: asset('components/'+n+'.svg',toggle(on,dis),72,36,n,'components')

def primary_button(label='重启并更新',ico='restart',state='normal'):
    fill='url(#primary)' if state=='normal' else '#90F4F5' if state=='hover' else '#29B9C3' if state=='pressed' else '#3B384E'
    color='#09161E' if state!='disabled' else P['muted']
    return rect(1,1,358,74,fill,12,stroke=P['cyan'] if state!='disabled' else '#5B5369',stroke_width=1)+icon(ico,85,21,33,color)+text(214,48,label,29,color,600,0,'middle')
def secondary_button(label='稍后',state='normal'):
    fill='#141122' if state=='normal' else '#272139' if state=='hover' else '#171420'
    color=P['violet'] if state!='disabled' else '#827990'
    return rect(1,1,158,74,fill,12,stroke=P['violet'] if state!='disabled' else '#4A405C',stroke_width=1)+text(80,48,label,27,color,500,0,'middle')
for state in ['normal','hover','pressed','disabled']: asset('components/button-primary-'+state+'.svg',primary_button(state=state),360,76,'主按钮 / '+state,'components')
for state in ['normal','hover','disabled']: asset('components/button-secondary-'+state+'.svg',secondary_button(state=state),160,76,'次按钮 / '+state,'components')
asset('components/button-primary-label-free.svg',rect(1,1,358,74,'url(#primary)',12,stroke=P['cyan'],stroke_width=1),360,76,'主按钮空白底板','components')
asset('components/button-secondary-label-free.svg',rect(1,1,158,74,P['panel'],12,stroke=P['violet'],stroke_width=1),160,76,'次按钮空白底板','components')

def progress(value=100,color=None,indeterminate=False):
    color=color or P['cyan']
    track=rect(0,0,1054,14,'#2C263D',7)
    return track+(rect(392,0,270,14,color,7) if indeterminate else rect(0,0,1054*value/100,14,color,7))
for n,val,col,ind in [('track',0,None,False),('downloading-64',64,None,False),('complete',100,None,False),('error-37',37,P['bad'],False),('checking',0,P['violet'],True)]:asset('components/progress-'+n+'.svg',progress(val,col,ind),1054,14,'进度条 / '+n,'components')

def badge(label,color,width,shield=False):
    shape=panel(1,1,width-2,32,6,fill='#10111B',stroke=color)
    if shield:shape+=path('M17 8 26 5l9 3v9l-9 8-9-8Z',fill=color)+text((width+28)/2,24,label,18,color,500,1,'middle')
    else:shape+=text(width/2,24,label,17,color,500,1,'middle')
    return shape
for n,label,color,w,shield in [('version','SYNCHRONIZE_02',P['violet'],208,False),('ready','READY',P['lime'],124,True),('downloading','DOWNLOADING',P['cyan'],188,False),('checking','CHECKING',P['violet'],146,False),('installing','INSTALLING',P['cyan'],158,False),('error','ERROR',P['bad'],124,True)]:asset('components/badge-'+n+'.svg',badge(label,color,w,shield),w,34,'状态徽章 / '+label,'components')

FEATURES=[('folder','工作区体验优化'),('ai-network','AI 对话稳定性提升'),('wrench','修复已知问题')]
for i,(ico,label) in enumerate(FEATURES):
    row=icon(ico,37,13,35)+text(114,42,label,24)+icon('chevron-right',1202,20,24,P['muted'])
    asset('components/feature-row-'+str(i+1)+'.svg',row,1246,66,label,'components')
asset('components/setting-auto-download.svg',icon('download',0,14,38)+text(70,28,'自动下载更新',25,P['ink'],600)+text(70,58,'空闲时安装，不打断当前任务',19,P['muted'])+group(toggle(),transform='translate(372 14)'),470,70,'自动更新设置行','components')
asset('typography/title-ready.svg',text(0,82,'更新已就绪',84,P['ink'],600),560,98,'更新就绪标题','typography')
asset('typography/subtitle-ready.svg',text(0,32,'已自动下载，重启即可使用新版本。',28,P['muted']),560,46,'更新就绪副标题','typography')
asset('typography/button-restart.svg',text(0,32,'重启并更新',29,'#09161E',600),176,44,'重启按钮文字','typography')
asset('typography/auto-update-label.svg',text(0,20,'AUTO UPDATE',17,P['cyan'],500,1.5),146,28,'自动更新英文标','typography')

STATES={
'ready':dict(title='更新已就绪',subtitle='已自动下载，重启即可使用新版本。',badge='READY',color=P['lime'],width=124,progress=100,progress_label='下载完成',percent='100%',verification='完整性校验通过',verify_icon='shield-check',primary='重启并更新',primary_icon='restart',secondary='稍后',disabled=False),
'downloading':dict(title='正在下载更新',subtitle='正在后台下载，不影响当前工作。',badge='DOWNLOADING',color=P['cyan'],width=188,progress=64,progress_label='下载中',percent='64%',verification='正在下载更新包',verify_icon='download',primary='后台继续',primary_icon='download',secondary='暂停',disabled=False),
'checking':dict(title='正在检查更新',subtitle='正在获取版本信息，请稍候。',badge='CHECKING',color=P['violet'],width=146,progress=0,progress_label='检查中',percent='检查中',verification='正在连接更新服务',verify_icon='activity',primary='请稍候',primary_icon='clock',secondary='取消',disabled=True),
'installing':dict(title='正在安装更新',subtitle='安装期间请勿关闭应用。',badge='INSTALLING',color=P['cyan'],width=158,progress=65,progress_label='安装进度',percent='65%',verification='正在写入更新文件',verify_icon='install',primary='安装中',primary_icon='install',secondary='请稍候',disabled=True),
'error':dict(title='更新失败',subtitle='连接中断，请检查网络后重试。',badge='ERROR',color=P['bad'],width=124,progress=37,progress_label='下载中断',percent='37%',verification='连接中断，请稍后重试。',verify_icon='warning',primary='重新下载',primary_icon='restart',secondary='稍后',disabled=False),
}
LAYERS=[]
def compose(state):
    s=STATES[state]
    layers=[]
    layers.append(layer('card-surface','01 · 卡片底板',base))
    layers.append(layer('header-surface','02 · 标题栏底板',header))
    hero=group(ART,transform='translate(562 60)')+rect(552,60,248,314,'url(#artFade)')
    layers.append(layer('hero-artwork','03 · 初音 × EVA 路径插画',group(hero,clip_path='url(#heroClip)')))
    eng=group(engineering,transform='translate(40 72)')+path('M50 109h70l-8 7H42Z',fill=P['violet'])+path('M52 109h9M66 109h9M80 109h9',stroke=P['panel'],stroke_width=2)
    layers.append(layer('engineering-decoration','04 · 工程装饰与标题条纹',eng))
    utility=group(logo,transform='translate(40 14) scale(.8)')+text(92,40,'sikeoop',28,P['ink'],600)+group(brackets,transform='translate(574 20)')+text(681,37,'AUTO UPDATE',17,P['cyan'],500,1.4,'middle')+icon('close',1291,20,26,P['violet'])
    layers.append(layer('header-controls','05 · 品牌标题与关闭图标',utility))
    title=text(56,208,s['title'],84,P['ink'],600)+text(56,266,s['subtitle'],28,P['muted'])
    layers.append(layer('title-copy','06 · 主标题与副标题',title))
    labels=group(badge('SYNCHRONIZE_02',P['violet'],208),transform='translate(56 286)')+group(badge(s['badge'],s['color'],s['width'],state in ['ready','error']),transform='translate(282 286)')
    layers.append(layer('status-badges','07 · 版本与状态徽章',labels))
    surface=content+line(58,396,58,419,stroke=P['violet'],stroke_width=4)+text(88,417,'本次更新',25,P['ink'],600)+list_surface
    layers.append(layer('content-panels','08 · 内容面板与列表底板',surface))
    rows=''
    for i,(ico,label) in enumerate(FEATURES):
        y=438+i*66
        rows+=icon(ico,93,y+13,35)+text(170,y+42,label,24)+icon('chevron-right',1258,y+20,24,P['muted'])
        if i<2:rows+=line(89,y+66,1272,y+66,stroke=P['line'],stroke_width=.8)
    layers.append(layer('feature-rows','09 · 更新项文字与图标',rows))
    completion=text(58,681,s['progress_label'],23,s['color'])+group(progress(s['progress'],P['bad'] if state=='error' else P['cyan'],state=='checking'),transform='translate(166 666)')+text(1302,681,s['percent'],24,s['color'],500,0,'end')+icon(s['verify_icon'],58,696,30,s['color'])+text(102,721,s['verification'],23,s['color'])
    layers.append(layer('progress-status','10 · 进度与完整性状态',completion))
    layers.append(layer('footer-panel','11 · 操作区底板',footer))
    setting=icon('download',60,794,38)+text(128,811,'自动下载更新',25,P['ink'],600)+text(128,842,'空闲时安装，不打断当前任务',19,P['muted'])+group(toggle(True,state=='installing'),transform='translate(430 798)')
    layers.append(layer('auto-download-setting','12 · 自动更新设置与开关',setting))
    buttons=group(secondary_button(s['secondary'],'disabled' if state=='installing' else 'normal'),transform='translate(782 782)')+group(primary_button(s['primary'],s['primary_icon'],'disabled' if s['disabled'] else 'normal'),transform='translate(960 782)')
    layers.append(layer('action-buttons','13 · 操作按钮',buttons))
    detail=group(hazard,transform='translate(44 884)')+text(120,897,'UNIT 01 / SIGNAL 39',13,P['muted'],400,1)+path('M424 888h508l17 17h340',fill='none',stroke=P['line'],stroke_width=.8)+border
    layers.append(layer('frame-and-footer','14 · 外框、警戒标与序列号',detail))
    return svg(''.join(layers),1360,912,'sikeoop / EVA × MIKU / '+state)

editable=compose('ready')
write('auto-update-card-editable.svg',editable)
outlined=OUTLINER.convert(editable)
write('auto-update-card.svg',outlined)
ASSETS.extend([dict(file='auto-update-card.svg',width=1360,height=912,label='整卡母版 / 字体已转轮廓',category='master'),dict(file='auto-update-card-editable.svg',width=1360,height=912,label='整卡母版 / 文字可编辑',category='master')])
for state in STATES:
    asset('states/update-'+state+'.svg',''.join(ET.tostring(el,encoding='unicode') for el in ET.fromstring(compose(state)) if el.tag.endswith('g')),1360,912,'更新状态 / '+state,'states')
root=ET.fromstring(outlined)
for el in root:
    if el.get(f'{{{INK}}}groupmode')=='layer':
        out=ET.Element(root.tag,root.attrib)
        out.append(deepcopy(root.find(f'{{{NS}}}defs')))
        out.append(deepcopy(el))
        n='layers/'+el.get('id')+'.svg'
        write(n,ET.tostring(out,encoding='unicode'))
        LAYERS.append(dict(id=el.get('id'),label=el.get(f'{{{INK}}}label'),file=n,width=1360,height=912))
        ASSETS.append(dict(file=n,width=1360,height=912,label=el.get(f'{{{INK}}}label'),category='layers'))

# Standalone symbol library, all embedded in one SVG with unique IDs.
symbols=[]
for n in ICONS:
    body=icon(n)
    symbols.append(f'<symbol id="{n}" viewBox="0 0 24 24">{body}</symbol>')
symbols.append(f'<symbol id="sikeoop-crystal" viewBox="0 0 40 40">{logo}</symbol>')
write('icons/sprite.svg',f'<svg xmlns="{NS}">'+''.join(symbols)+'</svg>')

# Full-resolution canvas rendition of the vector master, not a PNG in SVG.
card_body=''.join(ET.tostring(e,encoding='unicode') for e in root if e.tag.endswith('g'))
canvas=rect(0,0,1536,1024,P['bg'])+group(card_body,transform='translate(88 54)')
asset('auto-update-card-on-canvas.svg',canvas,1536,1024,'整卡带展示背景','master')

def nested_asset(filename,x,y,w,h,prefix):
    el=ET.parse(ROOT/filename).getroot()
    mapping={a.get('id'):prefix+'-'+a.get('id') for a in el.iter() if a.get('id')}
    for a in el.iter():
        for k,v in list(a.attrib.items()):
            if k=='id':a.set(k,mapping[v])
            else:
                for old,new in mapping.items():
                    v=v.replace('url(#'+old+')','url(#'+new+')')
                    if v=='#'+old:v='#'+new
                a.set(k,v)
    el.set('x',str(x));el.set('y',str(y));el.set('width',str(w));el.set('height',str(h))
    el.set('preserveAspectRatio','xMidYMid meet')
    return ET.tostring(el,encoding='unicode')

sheet=rect(0,0,1440,1360,P['bg'])+text(40,67,'AUTO UPDATE / SVG ASSET KIT',34,P['ink'],600,2)+text(42,107,'21 ICONS  ·  14 LAYERS  ·  5 UPDATE STATES',17,P['muted'],400,1)
for i,n in enumerate(list(ICONS)+['sikeoop-crystal']):
    x=40+i%7*194;y=142+i//7*116
    sheet+=rect(x,y,178,103,P['panel'],8,stroke=P['line'],stroke_width=1)
    sheet+=nested_asset('icons/'+n+'.svg',x+61,y+15,54,54,'sheet-icon-'+str(i))
    sheet+=text(x+89,y+89,n,13,P['muted'],400,0,'middle')
sheet+=text(40,553,'COMPONENTS / INDEPENDENT ASSETS',24,P['ink'],600,1)
core=['button-primary-normal','button-primary-hover','button-primary-pressed','button-primary-disabled','button-secondary-normal','button-secondary-hover','toggle-on','toggle-off','toggle-disabled','progress-complete','progress-downloading-64','progress-error-37','badge-version','badge-ready','badge-error','setting-auto-download']
for i,n in enumerate(core):
    x=40+i%4*342;y=581+i//4*173
    sheet+=rect(x,y,326,158,P['panel'],8,stroke=P['line'],stroke_width=1)
    sheet+=nested_asset('components/'+n+'.svg',x+16,y+13,294,93,'sheet-component-'+str(i))
    sheet+=text(x+163,y+141,n,13,P['muted'],400,0,'middle')
sheet+=text(40,1329,'Native UI geometry + outlined typography. Illustration supplied separately as actual color paths.',15,P['muted'])
asset('previews/asset-overview.svg',sheet,1440,1360,'图标与核心控件 SVG 总览','overview')

write('tokens.json',json.dumps({'theme':'SYNCHRONIZE_02 / EVA × MIKU','palette':P,'cardSize':[1360,912],'referenceCanvas':[1536,1024],'geometry':{'hero':[562,60,796,314],'contentPanel':[22,374,1314,374],'featureList':[56,438,1246,198],'progress':[166,666,1054,14],'footerPanel':[22,760,1314,112],'primaryButton':[960,782,360,76],'secondaryButton':[782,782,160,76],'toggle':[430,798,72,36]},'states':STATES},ensure_ascii=False,indent=2)+'\n')
write('assets.json',json.dumps({'assets':ASSETS,'layers':LAYERS,'allSVGsContainNoRaster':True},ensure_ascii=False,indent=2)+'\n')

# Every gallery thumbnail uses the real supplied SVG, including the trace.
cards=''.join(f'<a class="asset" href="{a["file"]}" download><div class="thumb"><img src="{a["file"]}" alt="{html.escape(a["label"])}"></div><strong>{html.escape(a["label"])}</strong><code>{a["file"]}</code><small>{a["width"]} × {a["height"]}</small></a>' for a in ASSETS if a['category'] not in ['layers','master','states'])
checks=''.join(f'<label><input type="checkbox" checked data-layer="{a["id"]}">{html.escape(a["label"])}</label>' for a in LAYERS)
inline=outlined
page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="icons/sikeoop-crystal.svg"><title>sikeoop / 自动更新卡 SVG 素材</title><style>
*{box-sizing:border-box}body{margin:0;background:#0B0C14;color:#F0EEF8;font:15px/1.6 -apple-system,"PingFang SC",sans-serif}.wrap{max-width:1480px;margin:auto;padding:40px}h1{font-size:34px;margin:8px 0}h2{font-size:24px;margin-top:42px}.eyebrow{font-size:12px;letter-spacing:3px;color:#5CE1E6}p,small{color:#A6A0B8}a{color:#5CE1E6;text-decoration:none}.links{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.links a,button{border:1px solid #514466;padding:8px 14px;border-radius:6px;background:#141122;color:#CEC9DD;cursor:pointer;font:inherit}.stage{background:#0B0C14;border:1px solid #382E50;border-radius:14px;padding:16px}.stage>svg,.hero-img{width:100%;height:auto;display:block}.state-row{display:flex;gap:10px;flex-wrap:wrap;margin:15px 0}.state-row button.on{color:#5CE1E6;border-color:#5CE1E6}.controls{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:20px 0}.controls label{font-size:13px}input{accent-color:#5CE1E6}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.asset{border:1px solid #302946;background:#141122;border-radius:9px;padding:14px;display:flex;flex-direction:column;gap:7px;overflow:hidden;color:#F0EEF8}.asset:hover{border-color:#5CE1E6}.thumb{height:120px;background:repeating-conic-gradient(#191629 0% 25%,#211C30 0% 50%) 50%/16px 16px;display:grid;place-items:center;border-radius:5px;overflow:hidden}.thumb img{width:90%;height:90%;object-fit:contain}.asset strong{font-size:14px}.asset code{font-size:10px;word-break:break-all;color:#A6A0B8}.note{padding:14px 20px;border-left:3px solid #FFB05C;background:#141122;font-size:13px;margin:20px 0}footer{margin:35px 0;color:#A6A0B8;font-size:12px}@media(max-width:900px){.wrap{padding:20px}.grid{grid-template-columns:repeat(2,1fr)}.controls{grid-template-columns:1fr 1fr}h1{font-size:28px}.thumb{height:100px}}
</style></head><body><div class="wrap"><div class="eyebrow">SIKEOOP / AUTO UPDATE / SVG ASSET KIT</div><h1>EVA × 初音未来 · 自动更新卡素材</h1><p>整卡、14 个注册图层、独立控件、21 个图标，以及 5 种更新状态。交付 SVG 均无内嵌 PNG。</p><div class="links"><a href="auto-update-card.svg" download>整卡 SVG（文字转轮廓）</a><a href="auto-update-card-editable.svg" download>文字可编辑 SVG</a><a href="assets.json">素材与图层映射</a><a href="README.md">使用说明</a></div><div class="note">角色主视觉已自动路径矢量化，接近原图但不是无损转换，也不是手工语义分件。所有 UI 元素是原生 SVG；文字轮廓版不依赖接收端字体。</div><h2>状态素材</h2><div class="state-row">'''
state_names={'ready':'已就绪','downloading':'下载中','checking':'检查中','installing':'安装中','error':'失败'}
page+=''.join(f'<button data-state="{s}" class="{"on" if s=="ready" else ""}">{state_names[s]}</button>' for s in STATES)
page+='''</div><div class="stage"><img id="state-preview" class="hero-img" src="states/update-ready.svg" alt="更新卡状态预览"></div><h2>整卡真实图层</h2><div class="links"><button id="show-all">显示全部</button><button id="hide-art">隐藏插画</button><button id="art-only">只看插画</button><span id="layer-count">14 / 14 层显示</span></div><div class="stage" id="layer-stage">'''+inline+'</div><div class="controls">'+checks+'''</div><h2>独立 SVG 素材 / 点击下载</h2><div class="grid">'''+cards+'''</div><footer>设计资产已生成与验证；没有执行更新，也没有接入正式应用。</footer></div><script>
const boxes=[...document.querySelectorAll('[data-layer]')],stage=document.querySelector('#layer-stage');function layers(){boxes.forEach(x=>stage.querySelector('#'+x.dataset.layer).style.display=x.checked?'':'none');document.querySelector('#layer-count').textContent=boxes.filter(x=>x.checked).length+' / 14 层显示';}boxes.forEach(x=>x.onchange=layers);document.querySelector('#show-all').onclick=()=>{boxes.forEach(x=>x.checked=true);layers();};document.querySelector('#hide-art').onclick=()=>{boxes.forEach(x=>x.checked=x.dataset.layer!=='hero-artwork');layers();};document.querySelector('#art-only').onclick=()=>{boxes.forEach(x=>x.checked=['card-surface','hero-artwork'].includes(x.dataset.layer));layers();};document.querySelectorAll('[data-state]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-state]').forEach(x=>x.classList.toggle('on',x===b));document.querySelector('#state-preview').src='states/update-'+b.dataset.state+'.svg';});layers();
</script></body></html>'''
write('index.html',page)
print(json.dumps({'assets':len(ASSETS),'svgFiles':len(list(ROOT.rglob('*.svg'))),'icons':len(ICONS)+1,'layers':len(LAYERS),'states':len(STATES)},ensure_ascii=False))
